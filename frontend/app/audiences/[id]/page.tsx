'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, Audience, AudienceVariable, Persona, SamplingJob } from '@/lib/api'
import { fmtDate, truncate, pct } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { PageSpinner } from '@/components/ui/Spinner'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { useToast } from '@/components/ui/Toast'

// ── Distribution type definitions ──────────────────────────────────────────

type DistType = 'normal' | 'log_normal' | 'uniform' | 'triangular' | 'beta' | 'exponential' | 'gamma' | 'categorical'

interface CatOption { label: string; weight: number }

interface VarFormState {
  name: string
  var_type: 'continuous' | 'categorical'
  sort_order: number
  dist_type: DistType
  // continuous params
  mean: string
  std: string
  real_mean: string
  real_std: string
  min: string
  max: string
  mode: string
  alpha: string
  beta: string
  lambda: string
  // categorical options
  cat_options: CatOption[]
}

const defaultForm = (): VarFormState => ({
  name: '',
  var_type: 'continuous',
  sort_order: 0,
  dist_type: 'normal',
  mean: '0', std: '1',
  real_mean: '50000', real_std: '20000',
  min: '0', max: '1',
  mode: '0.5',
  alpha: '2', beta: '5',
  lambda: '1',
  cat_options: [{ label: 'Option A', weight: 50 }, { label: 'Option B', weight: 50 }],
})

function buildDistribution(form: VarFormState): Record<string, unknown> {
  const n = (s: string) => parseFloat(s) || 0
  if (form.var_type === 'categorical') {
    return {
      type: 'categorical',
      options: form.cat_options.map(o => ({ label: o.label, weight: o.weight })),
    }
  }
  switch (form.dist_type) {
    case 'normal':
      return { type: 'normal', mean: n(form.mean), std: n(form.std) }
    case 'log_normal':
      return { type: 'log_normal', real_mean: n(form.real_mean), real_std: n(form.real_std) }
    case 'uniform':
      return { type: 'uniform', min: n(form.min), max: n(form.max) }
    case 'triangular':
      return { type: 'triangular', min: n(form.min), max: n(form.max), mode: n(form.mode) }
    case 'beta':
      return { type: 'beta', alpha: n(form.alpha), beta: n(form.beta) }
    case 'exponential':
      return { type: 'exponential', lambda: n(form.lambda) }
    case 'gamma':
      return { type: 'gamma', alpha: n(form.alpha), beta: n(form.beta) }
    default:
      return { type: form.dist_type }
  }
}

// ── Variable form component ─────────────────────────────────────────────────

function VariableFormFields({
  form, setForm,
}: {
  form: VarFormState
  setForm: React.Dispatch<React.SetStateAction<VarFormState>>
}) {
  const set = (patch: Partial<VarFormState>) => setForm(f => ({ ...f, ...patch }))

  const inputCls = 'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500'
  const labelCls = 'block text-sm font-medium text-gray-700'
  const rowCls = 'grid grid-cols-2 gap-3'

  // Continuous distribution type options
  const contDistOptions: { value: DistType; label: string }[] = [
    { value: 'normal', label: 'Normal (mean + std)' },
    { value: 'log_normal', label: 'Log-Normal (real mean + std)' },
    { value: 'uniform', label: 'Uniform (min – max)' },
    { value: 'triangular', label: 'Triangular (min, max, mode)' },
    { value: 'beta', label: 'Beta (α, β) — range [0,1]' },
    { value: 'exponential', label: 'Exponential (λ)' },
    { value: 'gamma', label: 'Gamma (α, β)' },
  ]

  return (
    <div className="space-y-4">
      {/* Name */}
      <div>
        <label className={labelCls}>Name <span className="text-red-500">*</span></label>
        <input
          type="text"
          required
          value={form.name}
          onChange={e => set({ name: e.target.value })}
          className={inputCls}
          placeholder="e.g. age, income, education_level"
        />
      </div>

      {/* var_type + sort_order row */}
      <div className={rowCls}>
        <div>
          <label className={labelCls}>Variable type</label>
          <select
            value={form.var_type}
            onChange={e => set({ var_type: e.target.value as 'continuous' | 'categorical', dist_type: e.target.value === 'categorical' ? 'categorical' : 'normal' })}
            className={inputCls}
          >
            <option value="continuous">Continuous</option>
            <option value="categorical">Categorical</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Sort order</label>
          <input
            type="number"
            min={0}
            value={form.sort_order}
            onChange={e => set({ sort_order: parseInt(e.target.value) || 0 })}
            className={inputCls}
          />
        </div>
      </div>

      {/* ── Continuous distribution ── */}
      {form.var_type === 'continuous' && (
        <>
          <div>
            <label className={labelCls}>Distribution</label>
            <select
              value={form.dist_type}
              onChange={e => set({ dist_type: e.target.value as DistType })}
              className={inputCls}
            >
              {contDistOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {form.dist_type === 'normal' && (
            <div className={rowCls}>
              <div>
                <label className={labelCls}>Mean</label>
                <input type="number" value={form.mean} onChange={e => set({ mean: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Std dev</label>
                <input type="number" min={0} value={form.std} onChange={e => set({ std: e.target.value })} className={inputCls} />
              </div>
            </div>
          )}

          {form.dist_type === 'log_normal' && (
            <div className={rowCls}>
              <div>
                <label className={labelCls}>Real mean</label>
                <input type="number" value={form.real_mean} onChange={e => set({ real_mean: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Real std dev</label>
                <input type="number" min={0} value={form.real_std} onChange={e => set({ real_std: e.target.value })} className={inputCls} />
              </div>
            </div>
          )}

          {(form.dist_type === 'uniform' || form.dist_type === 'triangular') && (
            <div className={`${form.dist_type === 'triangular' ? 'grid grid-cols-3' : rowCls} gap-3`}>
              <div>
                <label className={labelCls}>Min</label>
                <input type="number" value={form.min} onChange={e => set({ min: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Max</label>
                <input type="number" value={form.max} onChange={e => set({ max: e.target.value })} className={inputCls} />
              </div>
              {form.dist_type === 'triangular' && (
                <div>
                  <label className={labelCls}>Mode</label>
                  <input type="number" value={form.mode} onChange={e => set({ mode: e.target.value })} className={inputCls} />
                </div>
              )}
            </div>
          )}

          {(form.dist_type === 'beta' || form.dist_type === 'gamma') && (
            <div className={rowCls}>
              <div>
                <label className={labelCls}>Alpha (α)</label>
                <input type="number" min={0.01} step={0.1} value={form.alpha} onChange={e => set({ alpha: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Beta (β)</label>
                <input type="number" min={0.01} step={0.1} value={form.beta} onChange={e => set({ beta: e.target.value })} className={inputCls} />
              </div>
            </div>
          )}

          {form.dist_type === 'exponential' && (
            <div>
              <label className={labelCls}>Lambda (λ) — rate</label>
              <input type="number" min={0.001} step={0.1} value={form.lambda} onChange={e => set({ lambda: e.target.value })} className={inputCls} />
            </div>
          )}
        </>
      )}

      {/* ── Categorical options ── */}
      {form.var_type === 'categorical' && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className={labelCls}>Options (label + weight)</label>
            <button
              type="button"
              onClick={() => set({ cat_options: [...form.cat_options, { label: '', weight: 10 }] })}
              className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
            >
              + Add option
            </button>
          </div>
          <div className="space-y-2">
            {form.cat_options.map((opt, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={opt.label}
                  onChange={e => {
                    const next = [...form.cat_options]
                    next[i] = { ...next[i], label: e.target.value }
                    set({ cat_options: next })
                  }}
                  placeholder="Label"
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <input
                  type="number"
                  min={0}
                  value={opt.weight}
                  onChange={e => {
                    const next = [...form.cat_options]
                    next[i] = { ...next[i], weight: parseFloat(e.target.value) || 0 }
                    set({ cat_options: next })
                  }}
                  placeholder="Weight"
                  className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => set({ cat_options: form.cat_options.filter((_, j) => j !== i) })}
                  className="text-gray-400 hover:text-red-500 text-lg leading-none px-1"
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-gray-400">Weights are relative — they don&apos;t need to sum to 100.</p>
        </div>
      )}
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function AudienceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { toast } = useToast()

  const [audience, setAudience] = useState<Audience | null>(null)
  const [personas, setPersonas] = useState<Persona[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Sampling job
  const [activeJob, setActiveJob] = useState<SamplingJob | null>(null)
  const [stoppingJob, setStoppingJob] = useState(false)
  const [resumingJob, setResumingJob] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [sampleModalOpen, setSampleModalOpen] = useState(false)
  const [sampling, setSampling] = useState(false)
  const [sampleForm, setSampleForm] = useState({
    n: 10,
    generate_backstories: false,
    reuse_existing: false,
  })

  // Start Fresh modal
  const [freshModalOpen, setFreshModalOpen] = useState(false)
  const [freshSampling, setFreshSampling] = useState(false)
  const [freshForm, setFreshForm] = useState({ n: 100, generate_backstories: false })

  // Add variable modal
  const [varModalOpen, setVarModalOpen] = useState(false)
  const [savingVar, setSavingVar] = useState(false)
  const [varForm, setVarForm] = useState<VarFormState>(defaultForm())

  // Edit variable modal
  const [editVar, setEditVar] = useState<AudienceVariable | null>(null)
  const [editForm, setEditForm] = useState<VarFormState>(defaultForm())
  const [savingEdit, setSavingEdit] = useState(false)

  // Delete confirm
  const [deletingVarId, setDeletingVarId] = useState<string | null>(null)

  // Prompt template
  const [promptTemplate, setPromptTemplate] = useState<string>('')
  const [savingTemplate, setSavingTemplate] = useState(false)

  // Delete audience
  const [deleteAudienceConfirm, setDeleteAudienceConfirm] = useState(false)
  const [deletingAudience, setDeletingAudience] = useState(false)

  async function handleDeleteAudience() {
    try {
      setDeletingAudience(true)
      await api.deleteAudience(id)
      toast('Audience deleted', 'success')
      window.location.href = '/audiences'
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error')
      setDeletingAudience(false)
    }
  }

  // Delete persona
  const [deletingPersonaId, setDeletingPersonaId] = useState<string | null>(null)

  async function handleDeletePersona(personaId: string) {
    try {
      setDeletingPersonaId(personaId)
      await api.deletePersona(id, personaId)
      setPersonas(ps => ps.filter(p => p.id !== personaId))
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to delete persona', 'error')
    } finally {
      setDeletingPersonaId(null)
    }
  }

  // Export
  const [exportIncludePersonas, setExportIncludePersonas] = useState(true)

  function handleExport() {
    const url = api.exportAudience(id, exportIncludePersonas)
    const a = document.createElement('a')
    a.href = url
    a.click()
  }

  // Correlations: map of "varAid__varBid" -> value string
  const [corrValues, setCorrValues] = useState<Record<string, string>>({})
  const [savingCorr, setSavingCorr] = useState(false)

  async function load() {
    try {
      setLoading(true)
      setError(null)
      const [aud, ps, jobs] = await Promise.all([
        api.getAudience(id),
        api.listPersonas(id),
        api.listSamplingJobs(id),
      ])
      setAudience(aud)
      setPersonas(ps)
      setPromptTemplate(aud.backstory_prompt_template ?? '')
      // Restore active job if the most recent one is still running/stopped
      if (jobs.length > 0 && (jobs[0].status === 'running' || jobs[0].status === 'stopped')) {
        setActiveJob(jobs[0])
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load audience')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  // Poll active job while running
  useEffect(() => {
    if (activeJob?.status === 'running') {
      pollingRef.current = setInterval(async () => {
        try {
          const job = await api.getSamplingJob(id, activeJob.id)
          setActiveJob(job)
          if (job.status !== 'running') {
            clearInterval(pollingRef.current!)
            pollingRef.current = null
            if (job.status === 'completed') {
              const ps = await api.listPersonas(id)
              setPersonas(ps)
            }
          }
        } catch { /* silent */ }
      }, 2000)
    }
    return () => {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null }
    }
  }, [activeJob?.id, activeJob?.status, id])

  async function handleStopJob() {
    if (!activeJob) return
    try {
      setStoppingJob(true)
      const job = await api.stopSamplingJob(id, activeJob.id)
      setActiveJob(job)
      toast('Sampling paused', 'info')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to stop job', 'error')
    } finally {
      setStoppingJob(false)
    }
  }

  async function handleResumeJob() {
    if (!activeJob) return
    try {
      setResumingJob(true)
      const job = await api.resumeSamplingJob(id, activeJob.id)
      setActiveJob(job)
      toast('Sampling resumed', 'success')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to resume job', 'error')
    } finally {
      setResumingJob(false)
    }
  }

  async function handleSample(e: React.FormEvent) {
    e.preventDefault()
    try {
      setSampling(true)
      const job = await api.samplePersonas(id, {
        n: sampleForm.n,
        generate_backstories: sampleForm.generate_backstories,
        reuse_existing: sampleForm.reuse_existing,
      })
      setSampleModalOpen(false)
      setActiveJob(job)
      toast('Sampling started in background', 'success')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Sampling failed', 'error')
    } finally {
      setSampling(false)
    }
  }

  async function handleStartFresh(e: React.FormEvent) {
    e.preventDefault()
    try {
      setFreshSampling(true)
      const job = await api.samplePersonasFresh(id, {
        n: freshForm.n,
        generate_backstories: freshForm.generate_backstories,
      })
      setFreshModalOpen(false)
      setActiveJob(job)
      setPersonas([])  // cleared server-side
      toast('Starting fresh — all previous personas deleted', 'info')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to start fresh sampling', 'error')
    } finally {
      setFreshSampling(false)
    }
  }

  async function handleAddVariable(e: React.FormEvent) {
    e.preventDefault()
    if (!varForm.name.trim()) return
    try {
      setSavingVar(true)
      await api.addVariable(id, {
        name: varForm.name.trim(),
        var_type: varForm.var_type,
        distribution: buildDistribution(varForm),
        sort_order: varForm.sort_order,
      })
      setVarModalOpen(false)
      setVarForm(defaultForm())
      toast('Variable added', 'success')
      const aud = await api.getAudience(id)
      setAudience(aud)
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to add variable', 'error')
    } finally {
      setSavingVar(false)
    }
  }

  function openEdit(v: AudienceVariable) {
    // Reconstruct form state from existing variable
    const dist = v.distribution as Record<string, unknown>
    const distType = (dist.type as DistType) ?? 'normal'
    const form: VarFormState = {
      ...defaultForm(),
      name: v.name,
      var_type: v.var_type,
      sort_order: v.sort_order,
      dist_type: v.var_type === 'categorical' ? 'categorical' : distType,
    }
    if (distType === 'normal') {
      form.mean = String(dist.mean ?? 0)
      form.std = String(dist.std ?? 1)
    } else if (distType === 'log_normal') {
      form.real_mean = String(dist.real_mean ?? 50000)
      form.real_std = String(dist.real_std ?? 20000)
    } else if (distType === 'uniform') {
      form.min = String(dist.min ?? 0)
      form.max = String(dist.max ?? 1)
    } else if (distType === 'triangular') {
      form.min = String(dist.min ?? 0)
      form.max = String(dist.max ?? 1)
      form.mode = String(dist.mode ?? 0.5)
    } else if (distType === 'beta' || distType === 'gamma') {
      form.alpha = String(dist.alpha ?? 2)
      form.beta = String(dist.beta ?? 5)
    } else if (distType === 'exponential') {
      form.lambda = String(dist.lambda ?? 1)
    }
    if (v.var_type === 'categorical') {
      const opts = dist.options as { label: string; weight: number }[] | undefined
      form.cat_options = opts ?? [{ label: 'Option A', weight: 50 }]
    }
    setEditVar(v)
    setEditForm(form)
  }

  async function handleEditVariable(e: React.FormEvent) {
    e.preventDefault()
    if (!editVar) return
    try {
      setSavingEdit(true)
      await api.updateVariable(id, editVar.id, {
        name: editForm.name.trim(),
        var_type: editForm.var_type,
        distribution: buildDistribution(editForm),
        sort_order: editForm.sort_order,
      })
      setEditVar(null)
      toast('Variable updated', 'success')
      const aud = await api.getAudience(id)
      setAudience(aud)
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to update variable', 'error')
    } finally {
      setSavingEdit(false)
    }
  }

  function corrKey(aId: string, bId: string) {
    return aId < bId ? `${aId}__${bId}` : `${bId}__${aId}`
  }

  async function handleSaveCorrelations() {
    const contVars = variables.filter(v => v.var_type === 'continuous')
    const correlations: { var_a_id: string; var_b_id: string; correlation: number }[] = []
    for (let i = 0; i < contVars.length; i++) {
      for (let j = i + 1; j < contVars.length; j++) {
        const key = corrKey(contVars[i].id, contVars[j].id)
        const raw = corrValues[key] ?? ''
        const val = parseFloat(raw)
        if (!isNaN(val) && val !== 0) {
          correlations.push({ var_a_id: contVars[i].id, var_b_id: contVars[j].id, correlation: Math.max(-1, Math.min(1, val)) })
        }
      }
    }
    try {
      setSavingCorr(true)
      await api.upsertCorrelations(id, correlations)
      toast(`Saved ${correlations.length} correlation${correlations.length !== 1 ? 's' : ''}`, 'success')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to save correlations', 'error')
    } finally {
      setSavingCorr(false)
    }
  }

  async function handleSaveTemplate() {
    try {
      setSavingTemplate(true)
      const aud = await api.updateAudience(id, {
        backstory_prompt_template: promptTemplate.trim() || null,
      })
      setAudience(aud)
      toast('Prompt template saved', 'success')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to save template', 'error')
    } finally {
      setSavingTemplate(false)
    }
  }

  async function handleDeleteVariable(varId: string) {
    try {
      setDeletingVarId(varId)
      await api.deleteVariable(id, varId)
      toast('Variable deleted', 'success')
      const aud = await api.getAudience(id)
      setAudience(aud)
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to delete variable', 'error')
    } finally {
      setDeletingVarId(null)
    }
  }

  function varTypeBadgeColor(type: AudienceVariable['var_type']): 'blue' | 'purple' {
    return type === 'continuous' ? 'blue' : 'purple'
  }

  if (loading) return <PageSpinner />

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button className="ml-2 underline" onClick={load}>Retry</button>
        </div>
      </div>
    )
  }

  if (!audience) return null

  const variables = (audience.variables ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Back link */}
      <Link href="/audiences" className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800 mb-6">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Audiences
      </Link>

      {/* Header */}
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{audience.name}</h1>
            <Badge color="indigo">{variables.length} variable{variables.length !== 1 ? 's' : ''}</Badge>
          </div>
          {audience.description && (
            <p className="mt-2 text-gray-500">{audience.description}</p>
          )}
          <p className="mt-1 text-xs text-gray-400">Created {fmtDate(audience.created_at)}</p>
        </div>
        {/* Header actions */}
        <div className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={exportIncludePersonas}
              onChange={e => setExportIncludePersonas(e.target.checked)}
              className="rounded border-gray-300 text-indigo-600"
            />
            incl. personas
          </label>
          <Button size="sm" variant="secondary" onClick={handleExport}>
            ↓ Export JSON
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleteAudienceConfirm(true)}>
            Delete
          </Button>
        </div>
      </div>

      {/* Variables Section */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-800">
            Variables
            {variables.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500">({variables.length})</span>
            )}
          </h2>
          <Button size="sm" onClick={() => { setVarForm(defaultForm()); setVarModalOpen(true) }}>
            + Add Variable
          </Button>
        </div>

        {variables.length === 0 ? (
          <Card>
            <CardBody>
              <div className="flex flex-col items-center justify-center py-10 text-center gap-3">
                <p className="text-sm text-gray-500">
                  No variables defined yet. Variables define the demographic and attitudinal dimensions of this audience.
                </p>
                <Button size="sm" variant="secondary" onClick={() => { setVarForm(defaultForm()); setVarModalOpen(true) }}>
                  Add your first variable
                </Button>
              </div>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-4 py-3 text-left font-medium text-gray-600">#</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Distribution</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600 w-20"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {variables.map(v => (
                    <tr key={v.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-400 text-xs">{v.sort_order}</td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-gray-900">{v.name}</span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge color={varTypeBadgeColor(v.var_type)}>{v.var_type}</Badge>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
                          {JSON.stringify(v.distribution).slice(0, 60)}
                          {JSON.stringify(v.distribution).length > 60 ? '…' : ''}
                        </code>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => openEdit(v)}
                            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteVariable(v.id)}
                            disabled={deletingVarId === v.id}
                            className="text-xs text-red-400 hover:text-red-600 font-medium disabled:opacity-50"
                          >
                            {deletingVarId === v.id ? '…' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      {/* Correlations Section */}
      {variables.filter(v => v.var_type === 'continuous').length >= 2 && (
        <section className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">Variable Correlations</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Set Pearson correlations between continuous variables (−1 to 1). Zero = independent.
                Used by the Cholesky sampler to generate realistic correlated traits.
              </p>
            </div>
            <Button size="sm" loading={savingCorr} onClick={handleSaveCorrelations}>
              Save Correlations
            </Button>
          </div>
          <Card>
            <div className="overflow-x-auto">
              {(() => {
                const contVars = variables.filter(v => v.var_type === 'continuous')
                return (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="px-3 py-2 text-left font-medium text-gray-500 w-32"></th>
                        {contVars.slice(1).map(v => (
                          <th key={v.id} className="px-3 py-2 text-center font-medium text-gray-600 min-w-[90px]">
                            {v.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {contVars.slice(0, -1).map((rowVar, ri) => (
                        <tr key={rowVar.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-medium text-gray-700 text-xs truncate max-w-[128px]">
                            {rowVar.name}
                          </td>
                          {contVars.slice(1).map((colVar, ci) => {
                            if (ci < ri) {
                              return <td key={colVar.id} className="px-3 py-2 bg-gray-50" />
                            }
                            const key = corrKey(rowVar.id, colVar.id)
                            return (
                              <td key={colVar.id} className="px-3 py-2 text-center">
                                <input
                                  type="number"
                                  min={-1} max={1} step={0.05}
                                  value={corrValues[key] ?? ''}
                                  onChange={e => setCorrValues(prev => ({ ...prev, [key]: e.target.value }))}
                                  placeholder="0"
                                  className="w-20 rounded border border-gray-300 px-2 py-1 text-xs text-center focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                />
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              })()}
            </div>
          </Card>
        </section>
      )}

      {/* Prompt Template Section */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">Backstory Prompt Template</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Customise how persona backstories are generated. Use{' '}
              <code className="rounded bg-gray-100 px-1 text-xs">{'{variable_name}'}</code>{' '}
              to insert a trait value.
            </p>
          </div>
          <Button size="sm" loading={savingTemplate} onClick={handleSaveTemplate}>
            Save Template
          </Button>
        </div>

        <Card>
          <CardBody>
            {/* Variable chips */}
            {variables.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {variables.map(v => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setPromptTemplate(t => t + '{' + v.name + '}')}
                    className="rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
                    title={'Insert {' + v.name + '}'}
                  >
                    + {'{' + v.name + '}'}
                  </button>
                ))}
              </div>
            )}

            <textarea
              rows={10}
              value={promptTemplate}
              onChange={e => setPromptTemplate(e.target.value)}
              placeholder={`Leave blank to use the default template, or write your own. Example:

You are a synthetic research participant.
You are {age} years old, {gender}, earning {income} per year.
You live in {location}.

Respond authentically as this person would.`}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
            />
            <p className="mt-2 text-xs text-gray-400">
              The LLM will elaborate this template into a richer 150–250 word first-person narrative when backstories are generated.
              Leave blank to use the built-in demographic template.
            </p>
          </CardBody>
        </Card>
      </section>

      {/* Personas Section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-800">
            Personas
            {personas.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500">({personas.length})</span>
            )}
          </h2>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setFreshModalOpen(true)}>
              Start Fresh
            </Button>
            <Button onClick={() => setSampleModalOpen(true)}>Sample More</Button>
          </div>
        </div>

        {/* Active job progress */}
        {activeJob && (activeJob.status === 'running' || activeJob.status === 'stopped' || activeJob.status === 'failed') && (
          <Card className="mb-4">
            <CardBody className="py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-gray-700">
                    {activeJob.n_completed} / {activeJob.n_requested} sampled
                  </span>
                  <Badge color={activeJob.status === 'running' ? 'indigo' : activeJob.status === 'stopped' ? 'yellow' : 'red'}>
                    {activeJob.status}
                  </Badge>
                  {activeJob.error && (
                    <span className="text-xs text-red-600 truncate max-w-xs">{activeJob.error}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  {activeJob.status === 'running' && (
                    <Button size="sm" variant="danger" loading={stoppingJob} onClick={handleStopJob}>
                      Stop
                    </Button>
                  )}
                  {activeJob.status === 'stopped' && (
                    <Button size="sm" loading={resumingJob} onClick={handleResumeJob}>
                      Resume
                    </Button>
                  )}
                </div>
              </div>
              <ProgressBar
                value={pct(activeJob.n_completed, activeJob.n_requested)}
                color={activeJob.status === 'failed' ? 'red' : activeJob.status === 'stopped' ? 'yellow' : 'indigo'}
                size="sm"
              />
            </CardBody>
          </Card>
        )}

        {personas.length === 0 ? (
          <Card>
            <CardBody>
              <p className="text-sm text-gray-500 text-center py-6">
                No personas yet. Click &ldquo;Sample Personas&rdquo; to generate synthetic profiles based on the audience variables.
              </p>
            </CardBody>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {personas.map(persona => (
              <Card key={persona.id}>
                <CardHeader className="flex items-center justify-between py-3">
                  <span className="text-xs font-mono text-gray-400">{persona.id.slice(0, 8)}…</span>
                  <div className="flex items-center gap-2">
                    {persona.flagged && <Badge color="red">Flagged</Badge>}
                    {persona.plausibility != null && (
                      <Badge color={persona.plausibility >= 0.7 ? 'green' : persona.plausibility >= 0.4 ? 'yellow' : 'red'}>
                        {(persona.plausibility * 100).toFixed(0)}%
                      </Badge>
                    )}
                    <button
                      onClick={() => handleDeletePersona(persona.id)}
                      disabled={deletingPersonaId === persona.id}
                      className="text-gray-300 hover:text-red-500 disabled:opacity-40 transition-colors"
                      title="Delete persona"
                    >
                      {deletingPersonaId === persona.id ? (
                        <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                      ) : (
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      )}
                    </button>
                  </div>
                </CardHeader>
                <CardBody className="py-3">
                  <dl className="space-y-1">
                    {Object.entries(persona.traits_json).slice(0, 6).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2 text-xs">
                        <dt className="text-gray-500 capitalize">{k.replace(/_/g, ' ')}</dt>
                        <dd className="font-medium text-gray-700 truncate max-w-[120px]">{String(v)}</dd>
                      </div>
                    ))}
                    {Object.keys(persona.traits_json).length > 6 && (
                      <p className="text-xs text-gray-400">+{Object.keys(persona.traits_json).length - 6} more</p>
                    )}
                  </dl>
                  {persona.backstory && (
                    <div className="mt-3 border-t border-gray-100 pt-2">
                      <p className="text-xs italic text-gray-500">
                        {truncate(persona.backstory, 120)}
                      </p>
                    </div>
                  )}
                  <p className="mt-2 text-xs text-gray-400">{fmtDate(persona.created_at)}</p>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Delete Audience Modal */}
      <Modal open={deleteAudienceConfirm} onClose={() => setDeleteAudienceConfirm(false)} title="Delete Audience">
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            Are you sure you want to delete <strong>{audience.name}</strong>?
            This permanently removes all variables, correlations, personas, and related experiments.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setDeleteAudienceConfirm(false)}>Cancel</Button>
            <Button variant="danger" loading={deletingAudience} onClick={handleDeleteAudience}>Delete</Button>
          </div>
        </div>
      </Modal>

      {/* Add Variable Modal */}
      <Modal open={varModalOpen} onClose={() => setVarModalOpen(false)} title="Add Variable" size="lg">
        <form onSubmit={handleAddVariable} className="space-y-4">
          <VariableFormFields form={varForm} setForm={setVarForm} />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setVarModalOpen(false)}>Cancel</Button>
            <Button type="submit" loading={savingVar}>Add Variable</Button>
          </div>
        </form>
      </Modal>

      {/* Edit Variable Modal */}
      <Modal open={editVar !== null} onClose={() => setEditVar(null)} title="Edit Variable" size="lg">
        <form onSubmit={handleEditVariable} className="space-y-4">
          <VariableFormFields form={editForm} setForm={setEditForm} />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditVar(null)}>Cancel</Button>
            <Button type="submit" loading={savingEdit}>Save Changes</Button>
          </div>
        </form>
      </Modal>

      {/* Sample More Modal */}
      <Modal open={sampleModalOpen} onClose={() => setSampleModalOpen(false)} title="Sample More Personas">
        <form onSubmit={handleSample} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Number of personas</label>
            <input
              type="number"
              min={1}
              max={10000}
              value={sampleForm.n}
              onChange={e => setSampleForm(f => ({ ...f, n: parseInt(e.target.value) || 10 }))}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sampleForm.generate_backstories}
                onChange={e => setSampleForm(f => ({ ...f, generate_backstories: e.target.checked }))}
                className="rounded border-gray-300 text-indigo-600"
              />
              <span className="font-medium text-gray-700">Generate backstories</span>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sampleForm.reuse_existing}
                onChange={e => setSampleForm(f => ({ ...f, reuse_existing: e.target.checked }))}
                className="rounded border-gray-300 text-indigo-600"
              />
              <span className="font-medium text-gray-700">Only generate what&apos;s missing (reuse existing)</span>
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setSampleModalOpen(false)}>Cancel</Button>
            <Button type="submit" loading={sampling}>
              {sampling ? 'Starting…' : `Sample ${sampleForm.n} Personas`}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Start Fresh Modal */}
      <Modal open={freshModalOpen} onClose={() => setFreshModalOpen(false)} title="Start Fresh">
        <form onSubmit={handleStartFresh} className="space-y-4">
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
            <strong>Warning:</strong> This will permanently delete all existing personas for this audience before generating new ones.
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Number of personas to generate</label>
            <input
              type="number"
              min={1}
              max={10000}
              value={freshForm.n}
              onChange={e => setFreshForm(f => ({ ...f, n: parseInt(e.target.value) || 100 }))}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={freshForm.generate_backstories}
              onChange={e => setFreshForm(f => ({ ...f, generate_backstories: e.target.checked }))}
              className="rounded border-gray-300 text-indigo-600"
            />
            <span className="font-medium text-gray-700">Generate backstories</span>
          </label>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setFreshModalOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={freshSampling}>
              Delete all &amp; regenerate
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
