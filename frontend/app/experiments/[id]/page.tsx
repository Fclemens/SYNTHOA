'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  api, Experiment, ExperimentDistVariable, Question, SchemaField, OutputSchema, PreflightReport,
  DistributionConfig, SimulationRun,
} from '@/lib/api'
import { fmtDate, fmtCost, fmtTokens, fmtDateTime, truncate, runStatusColor, pct } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { PageSpinner } from '@/components/ui/Spinner'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { useToast } from '@/components/ui/Toast'

type Tab = 'overview' | 'variables' | 'questions' | 'schema' | 'launch'

// ── Distribution form (same pattern as audience variables) ───────────────────

type DistType = 'normal' | 'log_normal' | 'uniform' | 'triangular' | 'beta' | 'exponential' | 'gamma' | 'categorical'
interface CatOption { label: string; weight: number }
interface VarFormState {
  name: string; var_type: 'continuous' | 'categorical'; sort_order: number
  dist_type: DistType; mean: string; std: string; real_mean: string; real_std: string
  min: string; max: string; mode: string; alpha: string; beta: string; lambda: string
  cat_options: CatOption[]
}
const defaultVarForm = (): VarFormState => ({
  name: '', var_type: 'continuous', sort_order: 0, dist_type: 'normal',
  mean: '0', std: '1', real_mean: '50000', real_std: '20000',
  min: '0', max: '1', mode: '0.5', alpha: '2', beta: '5', lambda: '1',
  cat_options: [{ label: 'Option A', weight: 50 }, { label: 'Option B', weight: 50 }],
})

function buildDistribution(form: VarFormState): DistributionConfig {
  const n = (s: string) => parseFloat(s) || 0
  if (form.var_type === 'categorical')
    return { type: 'categorical', options: form.cat_options.map(o => ({ label: o.label, weight: o.weight })) }
  switch (form.dist_type) {
    case 'normal': return { type: 'normal', mean: n(form.mean), std: n(form.std) }
    case 'log_normal': return { type: 'log_normal', real_mean: n(form.real_mean), real_std: n(form.real_std) }
    case 'uniform': return { type: 'uniform', min: n(form.min), max: n(form.max) }
    case 'triangular': return { type: 'triangular', min: n(form.min), max: n(form.max), mode: n(form.mode) }
    case 'beta': return { type: 'beta', alpha: n(form.alpha), beta: n(form.beta) }
    case 'exponential': return { type: 'exponential', lambda: n(form.lambda) }
    case 'gamma': return { type: 'gamma', alpha: n(form.alpha), beta: n(form.beta) }
    default: return { type: form.dist_type }
  }
}

function distSummary(v: ExperimentDistVariable): string {
  const d = v.distribution as Record<string, unknown>
  const t = d.type as string
  if (t === 'categorical') {
    const opts = (d.options as { label: string }[]) ?? []
    return opts.map(o => o.label).join(', ')
  }
  if (t === 'normal') return `N(${d.mean}, ${d.std})`
  if (t === 'log_normal') return `LogN(μ=${d.real_mean}, σ=${d.real_std})`
  if (t === 'uniform') return `U[${d.min}, ${d.max}]`
  if (t === 'triangular') return `Tri(${d.min}, ${d.max}, mode=${d.mode})`
  if (t === 'beta') return `Beta(${d.alpha}, ${d.beta})`
  if (t === 'exponential') return `Exp(λ=${d.lambda})`
  if (t === 'gamma') return `Gamma(${d.alpha}, ${d.beta})`
  return t
}

function VarFormFields({ form, setForm }: { form: VarFormState; setForm: React.Dispatch<React.SetStateAction<VarFormState>> }) {
  const set = (patch: Partial<VarFormState>) => setForm(f => ({ ...f, ...patch }))
  const inp = 'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500'
  const lbl = 'block text-sm font-medium text-gray-700'
  const row = 'grid grid-cols-2 gap-3'
  const contOpts = [
    { value: 'normal', label: 'Normal' }, { value: 'log_normal', label: 'Log-Normal' },
    { value: 'uniform', label: 'Uniform' }, { value: 'triangular', label: 'Triangular' },
    { value: 'beta', label: 'Beta [0,1]' }, { value: 'exponential', label: 'Exponential' },
    { value: 'gamma', label: 'Gamma' },
  ]
  return (
    <div className="space-y-4">
      <div>
        <label className={lbl}>Name <span className="text-red-500">*</span></label>
        <input type="text" required value={form.name} onChange={e => set({ name: e.target.value })} className={inp} placeholder="e.g. price, brand, region" />
      </div>
      <div>
        <label className={lbl}>Variable type</label>
        <select value={form.var_type} onChange={e => set({ var_type: e.target.value as 'continuous' | 'categorical', dist_type: e.target.value === 'categorical' ? 'categorical' : 'normal' })} className={inp}>
          <option value="continuous">Continuous</option>
          <option value="categorical">Categorical</option>
        </select>
      </div>
      {form.var_type === 'continuous' && (
        <>
          <div>
            <label className={lbl}>Distribution</label>
            <select value={form.dist_type} onChange={e => set({ dist_type: e.target.value as DistType })} className={inp}>
              {contOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {form.dist_type === 'normal' && <div className={row}><div><label className={lbl}>Mean</label><input type="number" value={form.mean} onChange={e => set({ mean: e.target.value })} className={inp} /></div><div><label className={lbl}>Std dev</label><input type="number" min={0} value={form.std} onChange={e => set({ std: e.target.value })} className={inp} /></div></div>}
          {form.dist_type === 'log_normal' && <div className={row}><div><label className={lbl}>Real mean</label><input type="number" value={form.real_mean} onChange={e => set({ real_mean: e.target.value })} className={inp} /></div><div><label className={lbl}>Real std</label><input type="number" min={0} value={form.real_std} onChange={e => set({ real_std: e.target.value })} className={inp} /></div></div>}
          {(form.dist_type === 'uniform' || form.dist_type === 'triangular') && (
            <div className={form.dist_type === 'triangular' ? 'grid grid-cols-3 gap-3' : row}>
              <div><label className={lbl}>Min</label><input type="number" value={form.min} onChange={e => set({ min: e.target.value })} className={inp} /></div>
              <div><label className={lbl}>Max</label><input type="number" value={form.max} onChange={e => set({ max: e.target.value })} className={inp} /></div>
              {form.dist_type === 'triangular' && <div><label className={lbl}>Mode</label><input type="number" value={form.mode} onChange={e => set({ mode: e.target.value })} className={inp} /></div>}
            </div>
          )}
          {form.dist_type === 'beta' && <div className={row}><div><label className={lbl}>Alpha (α)</label><input type="number" min={0} value={form.alpha} onChange={e => set({ alpha: e.target.value })} className={inp} /></div><div><label className={lbl}>Beta (β)</label><input type="number" min={0} value={form.beta} onChange={e => set({ beta: e.target.value })} className={inp} /></div></div>}
          {form.dist_type === 'exponential' && <div><label className={lbl}>Lambda (λ)</label><input type="number" min={0} value={form.lambda} onChange={e => set({ lambda: e.target.value })} className={inp} /></div>}
          {form.dist_type === 'gamma' && <div className={row}><div><label className={lbl}>Alpha (α)</label><input type="number" min={0} value={form.alpha} onChange={e => set({ alpha: e.target.value })} className={inp} /></div><div><label className={lbl}>Beta (β)</label><input type="number" min={0} value={form.beta} onChange={e => set({ beta: e.target.value })} className={inp} /></div></div>}
        </>
      )}
      {form.var_type === 'categorical' && (
        <div>
          <label className={lbl}>Options</label>
          <div className="mt-1 space-y-2">
            {form.cat_options.map((opt, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="text" value={opt.label} onChange={e => { const opts = [...form.cat_options]; opts[i] = { ...opts[i], label: e.target.value }; set({ cat_options: opts }) }} className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" placeholder="Label" />
                <input type="number" min={0} value={opt.weight} onChange={e => { const opts = [...form.cat_options]; opts[i] = { ...opts[i], weight: parseFloat(e.target.value) || 0 }; set({ cat_options: opts }) }} className="w-20 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" placeholder="Weight" />
                <button type="button" onClick={() => set({ cat_options: form.cat_options.filter((_, j) => j !== i) })} className="text-gray-300 hover:text-red-500"><svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
              </div>
            ))}
            <Button type="button" size="sm" variant="outline" onClick={() => set({ cat_options: [...form.cat_options, { label: '', weight: 1 }] })}>+ Add option</Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Question type helpers ────────────────────────────────────────────────────

function questionTypeColor(t: Question['question_type']): 'blue' | 'purple' | 'green' | 'indigo' {
  switch (t) {
    case 'scale': return 'blue'
    case 'single_choice': return 'indigo'
    case 'multiple_choice': return 'purple'
    default: return 'green'
  }
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function ExperimentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  const [experiment, setExperiment] = useState<Experiment | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const t = searchParams.get('tab')
    return (t === 'launch' || t === 'variables' || t === 'questions' || t === 'schema') ? t : 'overview'
  })
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    try {
      setDeleting(true)
      await api.deleteExperiment(id)
      toast('Experiment deleted', 'success')
      router.push('/experiments')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error')
      setDeleting(false)
    }
  }

  async function loadExperiment() {
    try {
      setLoading(true)
      setError(null)
      const exp = await api.getExperiment(id)
      setExperiment(exp)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load experiment')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadExperiment() }, [id])

  if (loading) return <PageSpinner />

  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button className="ml-2 underline" onClick={loadExperiment}>Retry</button>
        </div>
      </div>
    )
  }

  if (!experiment) return null

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'variables', label: `Variables (${experiment.dist_variables?.length ?? 0})` },
    { key: 'questions', label: `Questions (${experiment.questions?.length ?? 0})` },
    { key: 'schema', label: 'Output Schema' },
    { key: 'launch', label: 'Launch' },
  ]

  return (
    <div className="space-y-6 max-w-4xl">
        {/* Back link */}
        <Link href="/experiments" className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800 mb-6">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Experiments
        </Link>

        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{experiment.name}</h1>
              <Badge color={experiment.execution_mode === 'pooled' ? 'blue' : 'purple'}>
                {experiment.execution_mode}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-gray-400">Created {fmtDate(experiment.created_at)}</p>
          </div>
          <Button size="sm" variant="danger" onClick={() => setDeleteConfirm(true)}>
            Delete
          </Button>
        </div>

        {/* Delete confirmation modal */}
        <Modal open={deleteConfirm} onClose={() => setDeleteConfirm(false)} title="Delete Experiment">
          <div className="space-y-4">
            <p className="text-sm text-gray-700">
              Are you sure you want to delete <strong>{experiment.name}</strong>?
              This will permanently remove all questions, variables, and simulation runs.
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="secondary" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
              <Button variant="danger" loading={deleting} onClick={handleDelete}>Delete</Button>
            </div>
          </div>
        </Modal>

        {/* Tabs */}
        <div className="mb-6 flex border-b border-gray-200">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab.key
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <OverviewTab experiment={experiment} onSaved={loadExperiment} />
        )}
        {activeTab === 'variables' && (
          <VariablesTab experiment={experiment} onChanged={loadExperiment} />
        )}
        {activeTab === 'questions' && (
          <QuestionsTab experiment={experiment} onChanged={loadExperiment} />
        )}
        {activeTab === 'schema' && (
          <SchemaTab experiment={experiment} onChanged={loadExperiment} />
        )}
        {activeTab === 'launch' && (
          <LaunchTab experiment={experiment} />
        )}
    </div>
  )
}

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ experiment, onSaved }: { experiment: Experiment; onSaved: () => void }) {
  const { toast } = useToast()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [audiences, setAudiences] = useState<{ id: string; name: string }[]>([])
  const [form, setForm] = useState({
    audience_id: experiment.audience_id,
    name: experiment.name,
    global_context: experiment.global_context ?? '',
    execution_mode: experiment.execution_mode,
    drift_detection_enabled: experiment.drift_detection_enabled ?? true,
  })

  useEffect(() => {
    api.listAudiences().then(list => setAudiences(list)).catch(() => {})
  }, [])

  async function handleSave() {
    try {
      setSaving(true)
      await api.updateExperiment(experiment.id, form)
      toast('Saved', 'success')
      setEditing(false)
      onSaved()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  const currentAudienceName = audiences.find(a => a.id === experiment.audience_id)?.name ?? experiment.audience_id

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Experiment Details</h2>
          {!editing ? (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" loading={saving} onClick={handleSave}>Save</Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Audience</label>
          {editing ? (
            <select
              value={form.audience_id}
              onChange={e => setForm(f => ({ ...f, audience_id: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              {audiences.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          ) : (
            <p className="text-gray-900">{currentAudienceName}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Name</label>
          {editing ? (
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          ) : (
            <p className="text-gray-900">{experiment.name}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Execution Mode</label>
          {editing ? (
            <>
              <select
                value={form.execution_mode}
                onChange={e => setForm(f => ({ ...f, execution_mode: e.target.value as 'pooled' | 'dedicated' }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="pooled">Pooled — all questions in one LLM call (fast, cheaper)</option>
                <option value="dedicated">Dedicated — one LLM call per question, multi-turn interview (realistic, costlier)</option>
              </select>
            </>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge color={experiment.execution_mode === 'pooled' ? 'blue' : 'purple'}>
                {experiment.execution_mode}
              </Badge>
              <span className="text-xs text-gray-400">
                {experiment.execution_mode === 'pooled'
                  ? 'All questions in one LLM call'
                  : 'One LLM call per question, multi-turn interview'}
              </span>
            </div>
          )}
        </div>

        {(editing ? form.execution_mode === 'dedicated' : experiment.execution_mode === 'dedicated') && (
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Drift Detection
              <span className="ml-1 normal-case font-normal text-gray-400">(dedicated mode only)</span>
            </label>
            {editing ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.drift_detection_enabled}
                  onChange={e => setForm(f => ({ ...f, drift_detection_enabled: e.target.checked }))}
                  className="rounded border-gray-300 text-indigo-600"
                />
                <span>Enabled — inject adherence checkpoints every 3 questions</span>
              </label>
            ) : (
              <div className="flex items-center gap-2">
                <Badge color={experiment.drift_detection_enabled ? 'green' : 'gray'}>
                  {experiment.drift_detection_enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                <span className="text-xs text-gray-400">
                  {experiment.drift_detection_enabled
                    ? 'Adds ~2 LLM calls every 3 questions to score persona adherence'
                    : 'No extra calls — faster and cheaper, no adherence scoring'}
                </span>
              </div>
            )}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Global Context</label>
          {editing ? (
            <textarea
              value={form.global_context}
              onChange={e => setForm(f => ({ ...f, global_context: e.target.value }))}
              rows={5}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="Background context shown at the start of each interview…"
            />
          ) : (
            <p className="text-sm text-gray-700 whitespace-pre-wrap">
              {experiment.global_context || <span className="text-gray-400 italic">None</span>}
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

// ── Variables Tab ─────────────────────────────────────────────────────────────

function VariablesTab({ experiment, onChanged }: { experiment: Experiment; onChanged: () => void }) {
  const { toast } = useToast()
  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ExperimentDistVariable | null>(null)
  const [form, setForm] = useState<VarFormState>(defaultVarForm())
  const [saving, setSaving] = useState(false)

  function openAdd() { setEditTarget(null); setForm(defaultVarForm()); setModalOpen(true) }

  function openEdit(v: ExperimentDistVariable) {
    setEditTarget(v)
    const d = v.distribution as Record<string, unknown>
    const t = d.type as DistType
    const base: Partial<VarFormState> = {
      name: v.name, var_type: v.var_type, sort_order: v.sort_order,
      dist_type: t === 'categorical' ? 'categorical' : t,
    }
    if (t === 'normal') { base.mean = String(d.mean ?? 0); base.std = String(d.std ?? 1) }
    else if (t === 'log_normal') { base.real_mean = String(d.real_mean ?? 50000); base.real_std = String(d.real_std ?? 20000) }
    else if (t === 'uniform') { base.min = String(d.min ?? 0); base.max = String(d.max ?? 1) }
    else if (t === 'triangular') { base.min = String(d.min ?? 0); base.max = String(d.max ?? 1); base.mode = String(d.mode ?? 0.5) }
    else if (t === 'beta') { base.alpha = String(d.alpha ?? 2); base.beta = String(d.beta ?? 5) }
    else if (t === 'exponential') { base.lambda = String(d.lambda ?? 1) }
    else if (t === 'gamma') { base.alpha = String(d.alpha ?? 2); base.beta = String(d.beta ?? 1) }
    else if (t === 'categorical') { base.cat_options = (d.options as CatOption[]) ?? [] }
    setForm(f => ({ ...f, ...base }))
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) return
    try {
      setSaving(true)
      const body = { name: form.name.trim(), var_type: form.var_type, distribution: buildDistribution(form), sort_order: form.sort_order }
      if (editTarget) {
        await api.updateExpDistVariable(experiment.id, editTarget.id, body)
        toast('Variable updated', 'success')
      } else {
        await api.addExpDistVariable(experiment.id, body)
        toast('Variable added', 'success')
      }
      setModalOpen(false)
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(v: ExperimentDistVariable) {
    if (!confirm(`Delete variable "${v.name}"?`)) return
    try {
      await api.deleteExpDistVariable(experiment.id, v.id)
      toast('Variable deleted', 'success')
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error')
    }
  }

  const vars = (experiment.dist_variables ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)

  // Compute which variable names are referenced in any question text
  const allQuestionText = (experiment.questions ?? []).map(q => q.question_text).join(' ')
  const referencedVarNames = new Set(
    Array.from(allQuestionText.matchAll(/\{([^}]+)\}/g), m => m[1])
  )

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-800">Experiment Variables</h2>
          <p className="text-xs text-gray-400 mt-0.5">Use <code className="bg-gray-100 px-1 rounded">{'{variable_name}'}</code> in question text to inject a sampled value at interview time.</p>
        </div>
        <Button size="sm" onClick={openAdd}>+ Add Variable</Button>
      </div>

      {vars.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-gray-500 text-center py-6">No variables yet. Add one to inject dynamic sampled values into question text.</p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="divide-y divide-gray-100">
            {vars.map(v => {
              const isUsed = referencedVarNames.has(v.name)
              return (
              <div key={v.id} className="flex items-center gap-4 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-semibold text-indigo-700">{'{' + v.name + '}'}</code>
                    <Badge color={v.var_type === 'continuous' ? 'blue' : 'purple'}>{v.var_type}</Badge>
                    {isUsed && <span className="text-xs text-green-600 font-medium">used in questions</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{distSummary(v)}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" variant="outline" onClick={() => openEdit(v)}>Edit</Button>
                  <button onClick={() => handleDelete(v)} className="text-gray-300 hover:text-red-500 transition-colors" title="Delete">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              </div>
            )})}
          </div>
        </Card>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editTarget ? 'Edit Variable' : 'Add Variable'} size="lg">
        <div className="space-y-4">
          <VarFormFields form={form} setForm={setForm} />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button loading={saving} onClick={handleSave} disabled={!form.name.trim()}>{editTarget ? 'Save Changes' : 'Add Variable'}</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}


// ── Questions Tab ─────────────────────────────────────────────────────────────

function QuestionsTab({ experiment, onChanged }: { experiment: Experiment; onChanged: () => void }) {
  const { toast } = useToast()
  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Question | null>(null)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const draggedId = useRef<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [orderedQuestions, setOrderedQuestions] = useState<Question[]>([])
  const distVars = experiment.dist_variables ?? []

  const [form, setForm] = useState({
    question_text: '',
    question_type: 'open_ended' as Question['question_type'],
    sort_order: (experiment.questions?.length ?? 0) + 1,
    ask_why: false,
    scale_min: 1,
    scale_max: 10,
    scale_anchor_low: '',
    scale_anchor_high: '',
    choices: '',
  })

  // Keep orderedQuestions in sync with experiment prop
  useEffect(() => {
    setOrderedQuestions((experiment.questions ?? []).slice().sort((a, b) => a.sort_order - b.sort_order))
  }, [experiment.questions])

  function resetForm() {
    setEditTarget(null)
    setForm({
      question_text: '',
      question_type: 'open_ended',
      sort_order: (experiment.questions?.length ?? 0) + 1,
      ask_why: false,
      scale_min: 1,
      scale_max: 10,
      scale_anchor_low: '',
      scale_anchor_high: '',
      choices: '',
    })
  }

  function openEdit(q: Question) {
    setEditTarget(q)
    setForm({
      question_text: q.question_text,
      question_type: q.question_type,
      sort_order: q.sort_order,
      ask_why: q.ask_why,
      scale_min: q.scale_min ?? 1,
      scale_max: q.scale_max ?? 10,
      scale_anchor_low: q.scale_anchor_low ?? '',
      scale_anchor_high: q.scale_anchor_high ?? '',
      choices: q.choices?.join(', ') ?? '',
    })
    setModalOpen(true)
  }

  function insertVariable(varName: string) {
    const token = `{${varName}}`
    const el = textareaRef.current
    if (!el) { setForm(f => ({ ...f, question_text: f.question_text + token })); return }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const newText = el.value.slice(0, start) + token + el.value.slice(end)
    setForm(f => ({ ...f, question_text: newText }))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length) })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.question_text.trim()) return
    try {
      setSaving(true)
      const body = {
        question_text: form.question_text.trim(),
        question_type: form.question_type,
        sort_order: form.sort_order,
        ask_why: form.ask_why,
        ...(form.question_type === 'scale' && {
          scale_min: form.scale_min, scale_max: form.scale_max,
          scale_anchor_low: form.scale_anchor_low || undefined,
          scale_anchor_high: form.scale_anchor_high || undefined,
        }),
        ...((form.question_type === 'multiple_choice' || form.question_type === 'single_choice') && {
          choices: form.choices.split(',').map(s => s.trim()).filter(Boolean),
        }),
      }
      if (editTarget) {
        await api.updateQuestion(experiment.id, editTarget.id, body)
        toast('Question updated', 'success')
      } else {
        await api.addQuestion(experiment.id, body as Omit<Question, 'id' | 'experiment_id'>)
        toast('Question added', 'success')
      }
      setModalOpen(false)
      resetForm()
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to save question', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(qId: string) {
    if (!confirm('Delete this question?')) return
    try {
      await api.deleteQuestion(experiment.id, qId)
      toast('Question deleted', 'success')
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error')
    }
  }

  // ── Drag & drop handlers ──────────────────────────────────────────────────

  function handleDragStart(id: string) {
    draggedId.current = id
  }

  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault()
    setDragOverId(id)
  }

  function handleDragEnd() {
    draggedId.current = null
    setDragOverId(null)
  }

  async function handleDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault()
    const srcId = draggedId.current
    if (!srcId || srcId === targetId) { setDragOverId(null); return }

    const qs = [...orderedQuestions]
    const srcIdx = qs.findIndex(q => q.id === srcId)
    const tgtIdx = qs.findIndex(q => q.id === targetId)
    if (srcIdx === -1 || tgtIdx === -1) return

    // Reorder optimistically
    const [moved] = qs.splice(srcIdx, 1)
    qs.splice(tgtIdx, 0, moved)
    setOrderedQuestions(qs)
    setDragOverId(null)
    draggedId.current = null

    try {
      await api.reorderQuestions(experiment.id, qs.map(q => q.id))
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Reorder failed', 'error')
      // Revert on failure
      onChanged()
    }
  }

  const inputCls = 'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500'

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-800">Questions</h2>
          {orderedQuestions.length > 1 && (
            <p className="text-xs text-gray-400 mt-0.5">Drag rows to reorder</p>
          )}
        </div>
        <Button size="sm" onClick={() => { resetForm(); setModalOpen(true) }}>+ Add Question</Button>
      </div>

      {orderedQuestions.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-gray-500 text-center py-6">No questions yet. Add some to define what will be asked.</p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="divide-y divide-gray-100">
            {orderedQuestions.map((q, i) => (
              <div
                key={q.id}
                draggable
                onDragStart={() => handleDragStart(q.id)}
                onDragOver={e => handleDragOver(e, q.id)}
                onDragEnd={handleDragEnd}
                onDrop={e => handleDrop(e, q.id)}
                className={`px-5 py-4 flex items-start gap-3 transition-colors ${
                  dragOverId === q.id ? 'bg-indigo-50' : 'hover:bg-gray-50'
                }`}
              >
                {/* Drag handle */}
                <div className="mt-1 flex-shrink-0 cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
                  </svg>
                </div>
                {/* Order badge */}
                <span className="mt-0.5 flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-indigo-50 text-xs font-semibold text-indigo-600">
                  {i + 1}
                </span>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800">{q.question_text}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Badge color={questionTypeColor(q.question_type)}>{q.question_type}</Badge>
                    {q.ask_why && <Badge color="yellow">ask why</Badge>}
                    {q.question_type === 'scale' && (
                      <span className="text-xs text-gray-500">
                        {q.scale_min} – {q.scale_max}
                        {q.scale_anchor_low && ` · "${q.scale_anchor_low}"`}
                        {q.scale_anchor_high && ` → "${q.scale_anchor_high}"`}
                      </span>
                    )}
                    {(q.question_type === 'multiple_choice' || q.question_type === 'single_choice') && q.choices && (
                      <span className="text-xs text-gray-500">{q.choices.join(', ')}</span>
                    )}
                  </div>
                </div>
                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => openEdit(q)}
                    className="text-gray-400 hover:text-indigo-600 transition-colors"
                    title="Edit question"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(q.id)}
                    className="text-gray-300 hover:text-red-500 transition-colors"
                    title="Delete question"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal open={modalOpen} onClose={() => { setModalOpen(false); resetForm() }} title={editTarget ? 'Edit Question' : 'Add Question'} size="lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Question Text <span className="text-red-500">*</span>
            </label>
            <textarea
              ref={textareaRef}
              required
              value={form.question_text}
              onChange={e => setForm(f => ({ ...f, question_text: e.target.value }))}
              rows={3}
              className={inputCls}
              placeholder="What do you think about…"
            />
            {distVars.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5 items-center">
                <span className="text-xs text-gray-400">Insert:</span>
                {distVars.map(v => (
                  <button key={v.id} type="button" onClick={() => insertVariable(v.name)}
                    className="inline-flex items-center rounded bg-indigo-50 px-2 py-0.5 text-xs font-mono text-indigo-700 hover:bg-indigo-100 transition-colors">
                    {'{' + v.name + '}'}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Type</label>
            <select value={form.question_type}
              onChange={e => setForm(f => ({ ...f, question_type: e.target.value as Question['question_type'] }))}
              className={inputCls}>
              <option value="open_ended">Open Ended</option>
              <option value="scale">Scale</option>
              <option value="single_choice">Single Choice</option>
              <option value="multiple_choice">Multiple Choice</option>
            </select>
          </div>

          {form.question_type === 'scale' && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Scale Min</label>
                  <input type="number" value={form.scale_min}
                    onChange={e => setForm(f => ({ ...f, scale_min: parseInt(e.target.value) }))}
                    className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Scale Max</label>
                  <input type="number" value={form.scale_max}
                    onChange={e => setForm(f => ({ ...f, scale_max: parseInt(e.target.value) }))}
                    className={inputCls} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Low anchor label <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input type="text" value={form.scale_anchor_low}
                    onChange={e => setForm(f => ({ ...f, scale_anchor_low: e.target.value }))}
                    className={inputCls} placeholder="e.g. Not at all likely" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">High anchor label <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input type="text" value={form.scale_anchor_high}
                    onChange={e => setForm(f => ({ ...f, scale_anchor_high: e.target.value }))}
                    className={inputCls} placeholder="e.g. Extremely likely" />
                </div>
              </div>
            </>
          )}

          {(form.question_type === 'multiple_choice' || form.question_type === 'single_choice') && (
            <div>
              <label className="block text-sm font-medium text-gray-700">Choices (comma-separated)</label>
              <input type="text" value={form.choices}
                onChange={e => setForm(f => ({ ...f, choices: e.target.value }))}
                className={inputCls}
                placeholder="Strongly Agree, Agree, Neutral, Disagree, Strongly Disagree" />
            </div>
          )}

          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.ask_why}
                onChange={e => setForm(f => ({ ...f, ask_why: e.target.checked }))}
                className="rounded border-gray-300 text-indigo-600" />
              <span className="font-medium text-gray-700">Ask follow-up &ldquo;Why?&rdquo;</span>
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setModalOpen(false); resetForm() }}>Cancel</Button>
            <Button type="submit" loading={saving}>{editTarget ? 'Save Changes' : 'Add Question'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

// ── Schema Tab ────────────────────────────────────────────────────────────────

function SchemaTab({ experiment, onChanged }: { experiment: Experiment; onChanged: () => void }) {
  const { toast } = useToast()
  const currentSchema: OutputSchema | undefined = experiment.output_schemas?.[0]
  const existingFields: SchemaField[] = currentSchema?.schema_json ?? []

  const [modalOpen, setModalOpen] = useState(false)
  const [fields, setFields] = useState<SchemaField[]>(existingFields)
  const [saving, setSaving] = useState(false)
  const [newField, setNewField] = useState({ key: '', type: 'string', description: '', enum_values: '' })

  function openModal() {
    setFields([...existingFields])
    setModalOpen(true)
  }

  function addField() {
    if (!newField.key.trim()) return
    const field: SchemaField = {
      key: newField.key.trim(),
      type: newField.type === 'enum'
        ? `enum(${newField.enum_values.split(',').map(s => s.trim()).filter(Boolean).join(',')})`
        : newField.type,
      description: newField.description.trim() || undefined,
    }
    setFields(f => [...f, field])
    setNewField({ key: '', type: 'string', description: '', enum_values: '' })
  }

  async function handleSave() {
    try {
      setSaving(true)
      await api.createOutputSchema(experiment.id, fields)
      toast('Schema saved', 'success')
      setModalOpen(false)
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold text-gray-800">Output Schema</h2>
        <Button size="sm" onClick={openModal}>
          {existingFields.length > 0 ? 'Edit Schema' : 'Define Schema'}
        </Button>
      </div>

      {existingFields.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-gray-500 text-center py-6">
              No output schema defined. Define one to control how responses are extracted.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Key</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {existingFields.map((f, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-indigo-700">{f.key}</td>
                    <td className="px-4 py-3">
                      <Badge color="gray">{f.type}</Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{f.description ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Edit Output Schema" size="xl">
        <div className="space-y-4">
          {/* Current fields */}
          {fields.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Fields</h3>
              <div className="rounded-lg border border-gray-200 divide-y divide-gray-100">
                {fields.map((f, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="flex-1 font-mono text-xs text-indigo-700">{f.key}</span>
                    <Badge color="gray">{f.type}</Badge>
                    <span className="flex-1 text-xs text-gray-500">{f.description ?? ''}</span>
                    <button
                      onClick={() => setFields(fs => fs.filter((_, j) => j !== i))}
                      className="text-gray-300 hover:text-red-500"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add field form */}
          <div className="rounded-lg bg-gray-50 p-4 space-y-3">
            <h3 className="text-sm font-medium text-gray-700">Add Field</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Key</label>
                <input
                  type="text"
                  value={newField.key}
                  onChange={e => setNewField(f => ({ ...f, key: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="brand_satisfaction"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Type</label>
                <select
                  value={newField.type}
                  onChange={e => setNewField(f => ({ ...f, type: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="string">string</option>
                  <option value="integer">integer</option>
                  <option value="float">float</option>
                  <option value="boolean">boolean</option>
                  <option value="scale">scale (1–10)</option>
                  <option value="enum">enum</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Description</label>
              <input
                type="text"
                value={newField.description}
                onChange={e => setNewField(f => ({ ...f, description: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                placeholder="Optional description"
              />
            </div>
            {newField.type === 'enum' && (
              <div>
                <label className="block text-xs text-gray-600 mb-1">Enum values (comma-separated)</label>
                <input
                  type="text"
                  value={newField.enum_values}
                  onChange={e => setNewField(f => ({ ...f, enum_values: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="low,medium,high"
                />
              </div>
            )}
            <Button size="sm" variant="outline" onClick={addField} disabled={!newField.key.trim()}>
              + Add Field
            </Button>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button loading={saving} onClick={handleSave} disabled={fields.length === 0}>Save Schema</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// ── Launch Tab ────────────────────────────────────────────────────────────────

function LaunchTab({ experiment }: { experiment: Experiment }) {
  const router = useRouter()
  const { toast } = useToast()

  const [preflight, setPreflight] = useState<PreflightReport | null>(null)
  const [preflightRunning, setPreflightRunning] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [runs, setRuns] = useState<SimulationRun[]>([])
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [form, setForm] = useState({
    population_size: 10,
    model_pass1: '',
    model_pass2: '',
    dual_extraction: true,
    sample_fresh: false,
  })
  const [defaultModels, setDefaultModels] = useState({ pass1: 'gpt-4o', pass2: 'gpt-4o-mini' })
  const [modelOptions, setModelOptions] = useState<string[]>([])

  // Load current settings to show effective model names
  useEffect(() => {
    api.getSettings().then(s => {
      setDefaultModels({ pass1: s.model_pass1, pass2: s.model_pass2 })
      const opts = Object.keys(s.model_pricing ?? {}).filter(k => k !== 'default')
      setModelOptions(opts)
      setForm(f => ({
        ...f,
        model_pass1: f.model_pass1 || s.model_pass1,
        model_pass2: f.model_pass2 || s.model_pass2,
      }))
    }).catch(() => {})
  }, [])

  // Load past runs on mount, and poll while any run is active
  async function loadRuns() {
    try {
      const data = await api.listRuns(experiment.id)
      setRuns(data)
      return data
    } catch { /* silent */ }
    return []
  }

  useEffect(() => {
    let cancelled = false
    loadRuns().then(data => {
      if (cancelled) return   // StrictMode fired cleanup before this resolved — bail out
      const hasActive = data.some(r => r.status === 'running' || r.status === 'pending')
      if (hasActive) {
        pollingRef.current = setInterval(async () => {
          const updated = await loadRuns()
          if (!updated.some(r => r.status === 'running' || r.status === 'pending')) {
            clearInterval(pollingRef.current!)
            pollingRef.current = null
          }
        }, 3000)
      }
    })
    return () => {
      cancelled = true
      if (pollingRef.current) { clearInterval(pollingRef.current!); pollingRef.current = null }
    }
  }, [experiment.id])

  async function runPreflight() {
    try {
      setPreflightRunning(true)
      const result = await api.preflight(experiment.id, {
        sample_size: form.population_size,
        model_pass1: form.model_pass1 || undefined,
        model_pass2: form.model_pass2 || undefined,
        dual_extraction: form.dual_extraction,
      })
      setPreflight(result)
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Preflight failed', 'error')
    } finally {
      setPreflightRunning(false)
    }
  }

  async function handleLaunch() {
    try {
      setLaunching(true)
      const run = await api.launchRun(experiment.id, {
        population_size: form.population_size,
        model_pass1: form.model_pass1 || undefined,
        model_pass2: form.model_pass2 || undefined,
        dual_extraction: form.dual_extraction,
        sample_fresh: form.sample_fresh,
      })
      toast('Simulation launched!', 'success')
      await loadRuns()
      router.push(`/runs/${run.id}`)
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Launch failed', 'error')
      setLaunching(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Launch Configuration */}
      <Card>
        <CardHeader>
          <h2 className="font-semibold text-gray-800">Launch Configuration</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700">Population Size</label>
              <input
                type="number"
                min={1}
                value={form.population_size}
                onChange={e => setForm(f => ({ ...f, population_size: parseInt(e.target.value) || 10 }))}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700">Model Pass 1 (interview)</label>
              <select
                value={form.model_pass1}
                onChange={e => setForm(f => ({ ...f, model_pass1: e.target.value }))}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
              >
                {modelOptions.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <p className="mt-0.5 text-xs text-gray-400">Default: {defaultModels.pass1}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Model Pass 2 (extraction)</label>
              <select
                value={form.model_pass2}
                onChange={e => setForm(f => ({ ...f, model_pass2: e.target.value }))}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
              >
                {modelOptions.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <p className="mt-0.5 text-xs text-gray-400">Default: {defaultModels.pass2}</p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.dual_extraction}
                onChange={e => setForm(f => ({ ...f, dual_extraction: e.target.checked }))}
                className="rounded border-gray-300 text-indigo-600"
              />
              <span className="font-medium text-gray-700">Dual extraction (higher confidence scoring)</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.sample_fresh}
                onChange={e => setForm(f => ({ ...f, sample_fresh: e.target.checked }))}
                className="rounded border-gray-300 text-indigo-600"
              />
              <span className="font-medium text-gray-700">Sample fresh personas</span>
              <span className="text-xs text-gray-400">(unchecked = reuse existing audience personas)</span>
            </label>
          </div>
        </CardBody>
      </Card>

      {/* Preflight */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">Preflight Check</h2>
            <Button size="sm" variant="outline" loading={preflightRunning} onClick={runPreflight}>
              Run Preflight Check
            </Button>
          </div>
        </CardHeader>
        {preflight ? (
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-lg bg-indigo-50 p-3 text-center">
                <p className="text-xs text-indigo-500 mb-1">Est. Cost</p>
                <p className="font-semibold text-indigo-700">{fmtCost(preflight.cost_estimate.grand_total)}</p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">Per Persona</p>
                <p className="font-semibold text-gray-700">{fmtCost(preflight.cost_estimate.per_persona)}</p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">P1 Tokens</p>
                <p className="font-semibold text-gray-700">{fmtTokens(preflight.token_estimate.pass1_input_tokens + preflight.token_estimate.pass1_output_tokens)}</p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">Sample Size</p>
                <p className="font-semibold text-gray-700">{preflight.sample_size}</p>
              </div>
            </div>

          </CardBody>
        ) : (
          <CardBody>
            <p className="text-sm text-gray-500">
              Run a preflight check to estimate token cost before launching.
            </p>
          </CardBody>
        )}
      </Card>

      {/* Launch Button */}
      <div className="flex justify-end">
        <Button size="lg" loading={launching} onClick={handleLaunch}>
          Launch Simulation
        </Button>
      </div>

      {/* Past Runs */}
      {runs.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-800 mb-3">
            Past Runs
            <span className="ml-2 text-sm font-normal text-gray-500">({runs.length})</span>
          </h2>
          <Card>
            <div className="divide-y divide-gray-100">
              {runs.map(run => {
                const isActive = run.status === 'running' || run.status === 'pending'
                const canExport = run.completed_tasks > 0
                const progress = pct(run.completed_tasks, run.total_tasks)
                return (
                  <div key={run.id} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors">
                    {/* Clickable info area */}
                    <Link href={`/runs/${run.id}`} className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs text-gray-400">{run.id.slice(0, 8)}…</span>
                        <Badge color={runStatusColor(run.status)}>{run.status}</Badge>
                        {run.failed_tasks > 0 && (
                          <Badge color="red">{run.failed_tasks} failed</Badge>
                        )}
                      </div>
                      {isActive ? (
                        <ProgressBar value={progress} color="indigo" size="sm" />
                      ) : (
                        <p className="text-xs text-gray-500">
                          {run.completed_tasks}/{run.total_tasks} tasks · {fmtCost(run.total_cost_usd)} · {fmtDateTime(run.created_at)}
                        </p>
                      )}
                    </Link>

                    {/* Export buttons */}
                    {canExport && (
                      <div className="flex gap-1 shrink-0">
                        <button
                          onClick={() => window.open(api.exportRun(run.id, 'csv'), '_blank')}
                          className="rounded px-2 py-1 text-xs text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors font-medium"
                          title="Export CSV"
                        >
                          CSV
                        </button>
                        <button
                          onClick={() => window.open(api.exportRun(run.id, 'xlsx'), '_blank')}
                          className="rounded px-2 py-1 text-xs text-gray-500 hover:text-green-600 hover:bg-green-50 transition-colors font-medium"
                          title="Export Excel"
                        >
                          XLSX
                        </button>
                      </div>
                    )}

                    <Link href={`/runs/${run.id}`}>
                      <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  </div>
                )
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
