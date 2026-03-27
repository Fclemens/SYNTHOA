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

type DistType = 'normal' | 'log_normal' | 'uniform' | 'triangular' | 'beta' | 'exponential' | 'gamma' | 'truncated_normal' | 'poisson' | 'weibull' | 'categorical' | 'ordinal'

interface CatOption { label: string; weight: number }

interface VarFormState {
  name: string
  var_type: 'continuous' | 'categorical' | 'ordinal'
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
  // output options
  round_to_int: boolean
  // bucket label normalisation
  normalize_labels: boolean
  bucket_labels: string[]   // custom ordered labels; length determines bucket count
  // categorical options
  cat_options: CatOption[]
  // ordinal options (ordered labels lowest → highest, with weights)
  ordinal_options: { label: string; weight: number }[]
}

const DEFAULT_BUCKET_PRESETS: Record<number, string[]> = {
  2: ['Low', 'High'],
  3: ['Low', 'Medium', 'High'],
  4: ['Low', 'Medium-Low', 'Medium-High', 'High'],
  5: ['Very Low', 'Low', 'Medium', 'High', 'Very High'],
  6: ['Very Low', 'Low', 'Medium-Low', 'Medium-High', 'High', 'Very High'],
  7: ['Very Low', 'Low', 'Below Average', 'Average', 'Above Average', 'High', 'Very High'],
}

const defaultForm = (): VarFormState => ({
  name: '',
  var_type: 'continuous',
  dist_type: 'truncated_normal',
  mean: '40', std: '15',
  real_mean: '50000', real_std: '20000',
  min: '18', max: '80',
  mode: '0.5',
  alpha: '2', beta: '5',
  lambda: '2',
  round_to_int: false,
  normalize_labels: false,
  bucket_labels: [...DEFAULT_BUCKET_PRESETS[5]],
  cat_options: [{ label: 'Option A', weight: 50 }, { label: 'Option B', weight: 50 }],
  ordinal_options: [{ label: 'Low', weight: 33 }, { label: 'Medium', weight: 34 }, { label: 'High', weight: 33 }],
})

function buildDistribution(form: VarFormState): Record<string, unknown> {
  const n = (s: string) => parseFloat(s) || 0
  const ri = form.round_to_int ? { round_to_int: true } : {}
  const nl = form.normalize_labels
    ? { normalize_labels: true, bucket_labels: form.bucket_labels.filter(l => l.trim() !== '') }
    : {}
  if (form.var_type === 'ordinal') {
    return {
      type: 'ordinal',
      options: form.ordinal_options.filter(o => o.label.trim() !== ''),
    }
  }
  if (form.var_type === 'categorical') {
    return {
      type: 'categorical',
      options: form.cat_options.map(o => ({ label: o.label, weight: o.weight })),
    }
  }
  switch (form.dist_type) {
    case 'normal':
      return { type: 'normal', mean: n(form.mean), std: n(form.std), ...ri, ...nl }
    case 'log_normal':
      return { type: 'log_normal', real_mean: n(form.real_mean), real_std: n(form.real_std), ...ri, ...nl }
    case 'uniform':
      return { type: 'uniform', min: n(form.min), max: n(form.max), ...ri, ...nl }
    case 'triangular':
      return { type: 'triangular', min: n(form.min), max: n(form.max), mode: n(form.mode), ...ri, ...nl }
    case 'beta':
      return { type: 'beta', alpha: n(form.alpha), beta: n(form.beta), ...ri, ...nl }
    case 'exponential':
      return { type: 'exponential', lambda: n(form.lambda), ...ri, ...nl }
    case 'gamma':
      return { type: 'gamma', alpha: n(form.alpha), beta: n(form.beta), ...ri, ...nl }
    case 'truncated_normal':
      return { type: 'truncated_normal', mean: n(form.mean), std: n(form.std), min: n(form.min), max: n(form.max), ...ri, ...nl }
    case 'poisson':
      return { type: 'poisson', lambda: n(form.lambda), ...ri, ...nl }
    case 'weibull':
      return { type: 'weibull', shape: n(form.alpha), scale: n(form.beta), ...nl }
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
    { value: 'truncated_normal', label: 'Truncated Normal (mean, std, min, max) — age, bounded vars' },
    { value: 'normal', label: 'Normal (mean + std)' },
    { value: 'log_normal', label: 'Log-Normal (real mean + std)' },
    { value: 'uniform', label: 'Uniform (min – max)' },
    { value: 'triangular', label: 'Triangular (min, max, mode)' },
    { value: 'beta', label: 'Beta (α, β) — range [0,1]' },
    { value: 'exponential', label: 'Exponential (λ)' },
    { value: 'gamma', label: 'Gamma (α, β)' },
    { value: 'poisson', label: 'Poisson (λ) — discrete counts' },
    { value: 'weibull', label: 'Weibull (shape, scale) — churn / tenure' },
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

      {/* var_type row */}
      <div>
        <label className={labelCls}>Variable type</label>
        <select
          value={form.var_type}
          onChange={e => {
            const vt = e.target.value as 'continuous' | 'categorical' | 'ordinal'
            set({
              var_type: vt,
              dist_type: vt === 'categorical' ? 'categorical' : vt === 'ordinal' ? 'ordinal' : 'truncated_normal',
            })
          }}
          className={inputCls}
        >
          <option value="continuous">Continuous (numeric)</option>
          <option value="categorical">Categorical (nominal)</option>
          <option value="ordinal">Ordinal (ordered categories)</option>
        </select>
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
                <input type="number" step="any" value={form.mean} onChange={e => set({ mean: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Std dev</label>
                <input type="number" step="any" min={0} value={form.std} onChange={e => set({ std: e.target.value })} className={inputCls} />
              </div>
            </div>
          )}

          {form.dist_type === 'log_normal' && (
            <div className={rowCls}>
              <div>
                <label className={labelCls}>Real mean</label>
                <input type="number" step="any" value={form.real_mean} onChange={e => set({ real_mean: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Real std dev</label>
                <input type="number" step="any" min={0} value={form.real_std} onChange={e => set({ real_std: e.target.value })} className={inputCls} />
              </div>
            </div>
          )}

          {(form.dist_type === 'uniform' || form.dist_type === 'triangular') && (
            <div className={`${form.dist_type === 'triangular' ? 'grid grid-cols-3' : rowCls} gap-3`}>
              <div>
                <label className={labelCls}>Min</label>
                <input type="number" step="any" value={form.min} onChange={e => set({ min: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Max</label>
                <input type="number" step="any" value={form.max} onChange={e => set({ max: e.target.value })} className={inputCls} />
              </div>
              {form.dist_type === 'triangular' && (
                <div>
                  <label className={labelCls}>Mode</label>
                  <input type="number" step="any" value={form.mode} onChange={e => set({ mode: e.target.value })} className={inputCls} />
                </div>
              )}
            </div>
          )}

          {(form.dist_type === 'beta' || form.dist_type === 'gamma') && (
            <div className={rowCls}>
              <div>
                <label className={labelCls}>Alpha (α)</label>
                <input type="number" step="any" min={0.001} value={form.alpha} onChange={e => set({ alpha: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Beta (β)</label>
                <input type="number" step="any" min={0.001} value={form.beta} onChange={e => set({ beta: e.target.value })} className={inputCls} />
              </div>
            </div>
          )}

          {form.dist_type === 'exponential' && (
            <div>
              <label className={labelCls}>Lambda (λ) — rate</label>
              <input type="number" step="any" min={0.001} value={form.lambda} onChange={e => set({ lambda: e.target.value })} className={inputCls} />
            </div>
          )}

          {form.dist_type === 'truncated_normal' && (
            <>
              <div className={rowCls}>
                <div>
                  <label className={labelCls}>Mean</label>
                  <input type="number" step="any" value={form.mean} onChange={e => set({ mean: e.target.value })} className={inputCls} placeholder="e.g. 40" />
                </div>
                <div>
                  <label className={labelCls}>Std dev</label>
                  <input type="number" step="any" min={0.001} value={form.std} onChange={e => set({ std: e.target.value })} className={inputCls} placeholder="e.g. 15" />
                </div>
              </div>
              <div className={rowCls}>
                <div>
                  <label className={labelCls}>Min (hard lower bound)</label>
                  <input type="number" step="any" value={form.min} onChange={e => set({ min: e.target.value })} className={inputCls} placeholder="e.g. 18" />
                </div>
                <div>
                  <label className={labelCls}>Max (hard upper bound)</label>
                  <input type="number" step="any" value={form.max} onChange={e => set({ max: e.target.value })} className={inputCls} placeholder="e.g. 80" />
                </div>
              </div>
            </>
          )}

          {form.dist_type === 'poisson' && (
            <div>
              <label className={labelCls}>Lambda (λ) — expected count</label>
              <input type="number" step="any" min={0.1} value={form.lambda} onChange={e => set({ lambda: e.target.value })} className={inputCls} placeholder="e.g. 2.5 for avg household size" />
              <p className="mt-1 text-xs text-gray-400">Outputs whole numbers (0, 1, 2, …). λ = mean = variance.</p>
            </div>
          )}

          {form.dist_type === 'weibull' && (
            <div className={rowCls}>
              <div>
                <label className={labelCls}>Shape (k)</label>
                <input type="number" step="any" min={0.001} value={form.alpha} onChange={e => set({ alpha: e.target.value })} className={inputCls} placeholder="e.g. 1.5" />
                <p className="mt-1 text-xs text-gray-400">{'<1 early churn · 1 constant · >1 wear-out'}</p>
              </div>
              <div>
                <label className={labelCls}>Scale (λ)</label>
                <input type="number" step="any" min={0.001} value={form.beta} onChange={e => set({ beta: e.target.value })} className={inputCls} placeholder="e.g. 24 (months)" />
                <p className="mt-1 text-xs text-gray-400">Characteristic lifetime value</p>
              </div>
            </div>
          )}

          {/* Round to integer */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="round_to_int"
              checked={form.round_to_int}
              onChange={e => set({ round_to_int: e.target.checked })}
              className="rounded border-gray-300 text-indigo-600"
            />
            <label htmlFor="round_to_int" className="text-sm text-gray-700 cursor-pointer">
              Round to nearest integer <span className="text-gray-400 text-xs">(e.g. age 34, income 52000)</span>
            </label>
          </div>

          {/* Bucket label normalisation */}
          <div className="rounded-lg bg-gray-50 px-3 py-2.5 border border-gray-200 space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="normalize_labels"
                checked={form.normalize_labels}
                onChange={e => set({ normalize_labels: e.target.checked })}
                className="rounded border-gray-300 text-indigo-600"
              />
              <label htmlFor="normalize_labels" className="text-sm font-medium text-gray-700 cursor-pointer">
                Normalise to bucket labels
              </label>
            </div>
            {form.normalize_labels && (
              <div className="space-y-2">
                {/* Preset picker */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 shrink-0">Preset:</span>
                  {[2,3,4,5,6,7].map(n => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => set({ bucket_labels: [...DEFAULT_BUCKET_PRESETS[n]] })}
                      className={`text-xs px-2 py-0.5 rounded border ${form.bucket_labels.length === n ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'}`}
                    >
                      {n === 2 ? 'Binary' : n === 3 ? 'Tertile' : n === 4 ? 'Quartile' : n === 5 ? 'Quintile' : n === 6 ? 'Sextile' : 'Septile'}
                    </button>
                  ))}
                </div>
                {/* Editable label list */}
                <div className="space-y-1">
                  {form.bucket_labels.map((lbl, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-400 w-4 text-right shrink-0">{i + 1}.</span>
                      <input
                        type="text"
                        value={lbl}
                        onChange={e => {
                          const next = [...form.bucket_labels]
                          next[i] = e.target.value
                          set({ bucket_labels: next })
                        }}
                        className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                        placeholder={`Label ${i + 1}`}
                      />
                      <button
                        type="button"
                        onClick={() => set({ bucket_labels: form.bucket_labels.filter((_, j) => j !== i) })}
                        disabled={form.bucket_labels.length <= 2}
                        className="text-gray-300 hover:text-red-400 disabled:opacity-30 text-sm leading-none"
                        title="Remove bucket"
                      >✕</button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => set({ bucket_labels: [...form.bucket_labels, `Label ${form.bucket_labels.length + 1}`] })}
                    className="text-xs text-indigo-600 hover:text-indigo-800 mt-1"
                  >+ Add bucket</button>
                </div>
                <p className="text-xs text-gray-400">
                  {form.bucket_labels.length} equal-probability buckets · lowest → highest
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Ordinal options ── */}
      {form.var_type === 'ordinal' && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <label className={labelCls}>Ordered categories</label>
              <p className="text-xs text-gray-400 mt-0.5">List from <strong>lowest</strong> to <strong>highest</strong> rank. Weights control relative frequency.</p>
            </div>
            <button
              type="button"
              onClick={() => set({ ordinal_options: [...form.ordinal_options, { label: '', weight: 33 }] })}
              className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
            >
              + Add level
            </button>
          </div>
          {/* header row */}
          <div className="flex items-center gap-2 mb-1 px-1">
            <span className="w-5 shrink-0" />
            <span className="flex-1 text-xs text-gray-400">Label</span>
            <span className="w-16 text-xs text-gray-400 text-right">Weight</span>
            <span className="w-12 text-xs text-gray-400 text-right">%</span>
            <span className="w-16 shrink-0" />
          </div>
          {(() => {
            const totalW = form.ordinal_options.reduce((s, o) => s + (o.weight || 0), 0) || 1
            return (
              <div className="space-y-1.5">
                {form.ordinal_options.map((opt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 w-5 text-right shrink-0">{i + 1}</span>
                    <input
                      type="text"
                      value={opt.label}
                      onChange={e => {
                        const next = [...form.ordinal_options]
                        next[i] = { ...next[i], label: e.target.value }
                        set({ ordinal_options: next })
                      }}
                      placeholder={`Level ${i + 1}`}
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={opt.weight}
                      onChange={e => {
                        const next = [...form.ordinal_options]
                        next[i] = { ...next[i], weight: parseFloat(e.target.value) || 0 }
                        set({ ordinal_options: next })
                      }}
                      className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-right focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <span className="w-12 text-xs text-gray-400 text-right">
                      {((opt.weight / totalW) * 100).toFixed(0)}%
                    </span>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button type="button" disabled={i === 0}
                        onClick={() => { const next = [...form.ordinal_options]; [next[i-1], next[i]] = [next[i], next[i-1]]; set({ ordinal_options: next }) }}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-sm px-1" title="Move up">↑</button>
                      <button type="button" disabled={i === form.ordinal_options.length - 1}
                        onClick={() => { const next = [...form.ordinal_options]; [next[i], next[i+1]] = [next[i+1], next[i]]; set({ ordinal_options: next }) }}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-sm px-1" title="Move down">↓</button>
                      <button type="button" disabled={form.ordinal_options.length <= 2}
                        onClick={() => set({ ordinal_options: form.ordinal_options.filter((_, j) => j !== i) })}
                        className="text-gray-400 hover:text-red-500 text-lg leading-none px-1 disabled:opacity-20" title="Remove">×</button>
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
          <p className="mt-2 text-xs text-indigo-600 bg-indigo-50 rounded-md px-2 py-1.5">
            ✦ Participates in the correlation matrix (ordinal correlation with continuous and binary variables).
          </p>
        </div>
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
    backstory_mode: 'none' as 'none' | 'template' | 'llm',
    reuse_existing: false,
  })

  // Start Fresh modal
  const [freshModalOpen, setFreshModalOpen] = useState(false)
  const [freshSampling, setFreshSampling] = useState(false)
  const [freshForm, setFreshForm] = useState({ n: 100, backstory_mode: 'llm' as 'none' | 'template' | 'llm' })

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
  const templateRef = useRef<HTMLTextAreaElement>(null)

  // Inline name editing
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [savingName, setSavingName] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  function startEditName() {
    if (!audience) return
    setNameInput(audience.name)
    setEditingName(true)
    setTimeout(() => nameInputRef.current?.select(), 0)
  }

  async function saveAudienceName() {
    if (!audience || !nameInput.trim()) return
    if (nameInput.trim() === audience.name) { setEditingName(false); return }
    try {
      setSavingName(true)
      const updated = await api.updateAudience(audience.id, { name: nameInput.trim() })
      setAudience(updated)
      setEditingName(false)
      toast('Audience renamed', 'success')
    } catch {
      toast('Failed to rename audience', 'error')
    } finally {
      setSavingName(false)
    }
  }

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
      const [aud, ps, jobs, corrs] = await Promise.all([
        api.getAudience(id),
        api.listPersonas(id),
        api.listSamplingJobs(id),
        api.getCorrelations(id),
      ])
      setAudience(aud)
      setPersonas(ps)
      setPromptTemplate(aud.backstory_prompt_template ?? '')
      // Hydrate correlation matrix from saved values
      const corrMap: Record<string, string> = {}
      for (const c of corrs) {
        const a = c.var_a_id, b = c.var_b_id
        const key = a < b ? `${a}__${b}` : `${b}__${a}`
        corrMap[key] = String(c.correlation)
      }
      setCorrValues(corrMap)
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

  async function handleCancelJob() {
    if (!activeJob) return
    try {
      await api.cancelSamplingJob(id, activeJob.id)
      setActiveJob(null)
      toast(`Job cancelled — ${activeJob.n_completed} personas kept`, 'info')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to cancel job', 'error')
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
        backstory_mode: sampleForm.backstory_mode,
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
        backstory_mode: freshForm.backstory_mode,
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
        sort_order: 0,
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
      dist_type: v.var_type === 'categorical' ? 'categorical' : v.var_type === 'ordinal' ? 'ordinal' : distType,
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
    } else if (distType === 'truncated_normal') {
      form.mean = String(dist.mean ?? 40)
      form.std = String(dist.std ?? 15)
      form.min = String(dist.min ?? 18)
      form.max = String(dist.max ?? 80)
    } else if (distType === 'poisson') {
      form.lambda = String(dist.lambda ?? 2)
    } else if (distType === 'weibull') {
      form.alpha = String(dist.shape ?? 1.5)   // shape → alpha field
      form.beta = String(dist.scale ?? 24)      // scale → beta field
    }
    if (v.var_type === 'categorical') {
      const opts = dist.options as { label: string; weight: number }[] | undefined
      form.cat_options = opts ?? [{ label: 'Option A', weight: 50 }]
    }
    if (v.var_type === 'ordinal') {
      const raw = dist.options as unknown[] | undefined
      if (raw && raw.length > 0) {
        // Normalise legacy string[] to {label,weight}[]
        form.ordinal_options = raw.map(o =>
          typeof o === 'string'
            ? { label: o, weight: 33 }
            : (o as { label: string; weight: number })
        )
      }
    }
    form.round_to_int = !!(dist.round_to_int)
    form.normalize_labels = !!(dist.normalize_labels || dist.bucket_labels)
    if (Array.isArray(dist.bucket_labels) && (dist.bucket_labels as string[]).length >= 2) {
      form.bucket_labels = dist.bucket_labels as string[]
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
        sort_order: 0,
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
    const copulaVars = variables.filter(isCopulaVar)
    const correlations: { var_a_id: string; var_b_id: string; correlation: number }[] = []
    for (let i = 0; i < copulaVars.length; i++) {
      for (let j = i + 1; j < copulaVars.length; j++) {
        const key = corrKey(copulaVars[i].id, copulaVars[j].id)
        const raw = corrValues[key] ?? ''
        const val = parseFloat(raw)
        if (!isNaN(val) && val !== 0) {
          correlations.push({ var_a_id: copulaVars[i].id, var_b_id: copulaVars[j].id, correlation: Math.max(-1, Math.min(1, val)) })
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

  function varTypeBadgeColor(type: AudienceVariable['var_type']): 'blue' | 'purple' | 'green' {
    if (type === 'continuous') return 'blue'
    if (type === 'ordinal') return 'purple'
    return 'green'
  }

  function isBinary(v: AudienceVariable): boolean {
    const dist = v.distribution as Record<string, unknown>
    return v.var_type === 'categorical' && Array.isArray(dist.options) && (dist.options as unknown[]).length === 2
  }

  function isCopulaVar(v: AudienceVariable): boolean {
    return v.var_type === 'continuous' || v.var_type === 'ordinal' || isBinary(v)
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
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  ref={nameInputRef}
                  type="text"
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveAudienceName(); if (e.key === 'Escape') setEditingName(false) }}
                  className="text-2xl font-bold text-gray-900 border-b-2 border-indigo-500 outline-none bg-transparent w-72"
                  disabled={savingName}
                  autoFocus
                />
                <button
                  onClick={saveAudienceName}
                  disabled={savingName || !nameInput.trim()}
                  className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {savingName ? '…' : 'Save'}
                </button>
                <button
                  onClick={() => setEditingName(false)}
                  disabled={savingName}
                  className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 group">
                <h1 className="text-2xl font-bold text-gray-900">{audience.name}</h1>
                <button
                  onClick={startEditName}
                  title="Rename audience"
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-indigo-600 p-1 rounded"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 2.828L11.828 15.828a2 2 0 01-1.415.586H8v-2.414A2 2 0 018.586 12.5L9 13z" />
                  </svg>
                </button>
              </div>
            )}
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
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Distribution</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600 w-20"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {variables.map(v => (
                    <tr key={v.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <span className="font-medium text-gray-900">{v.name}</span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge color={varTypeBadgeColor(v.var_type)}>
                          {v.var_type}{isBinary(v) ? ' · binary' : ''}
                        </Badge>
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
      {variables.filter(isCopulaVar).length >= 2 && (
        <section className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">Variable Correlations</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Pearson-style correlations (−1 to 1) between continuous, ordinal, and binary variables.
                Zero = independent. Used by the Cholesky sampler.
              </p>
              <div className="flex items-center gap-3 mt-1.5">
                <span className="inline-flex items-center gap-1 text-xs text-gray-500"><span className="w-2 h-2 rounded-full bg-blue-400 inline-block" /> continuous</span>
                <span className="inline-flex items-center gap-1 text-xs text-gray-500"><span className="w-2 h-2 rounded-full bg-purple-400 inline-block" /> ordinal</span>
                <span className="inline-flex items-center gap-1 text-xs text-gray-500"><span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> binary</span>
              </div>
            </div>
            <Button size="sm" loading={savingCorr} onClick={handleSaveCorrelations}>
              Save Correlations
            </Button>
          </div>
          <Card>
            <div className="overflow-x-auto">
              {(() => {
                const copulaVars = variables.filter(isCopulaVar)
                const dotColor = (v: AudienceVariable) =>
                  v.var_type === 'continuous' ? 'bg-blue-400' :
                  v.var_type === 'ordinal' ? 'bg-purple-400' : 'bg-green-400'
                return (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="px-3 py-2 text-left font-medium text-gray-500 w-32"></th>
                        {copulaVars.slice(1).map(v => (
                          <th key={v.id} className="px-3 py-2 text-center font-medium text-gray-600 min-w-[90px]">
                            <div className="flex items-center justify-center gap-1">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor(v)}`} />
                              {v.name}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {copulaVars.slice(0, -1).map((rowVar, ri) => (
                        <tr key={rowVar.id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 text-xs truncate max-w-[128px]">
                            <div className="flex items-center gap-1">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor(rowVar)}`} />
                              <span className="font-medium text-gray-700">{rowVar.name}</span>
                            </div>
                          </td>
                          {copulaVars.slice(1).map((colVar, ci) => {
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
      {(() => {
        const varNames = new Set(variables.map(v => v.name))
        const usedTokens = new Set([...promptTemplate.matchAll(/\{([^}]+)\}/g)].map(m => m[1].trim()).filter(t => varNames.has(t)))
        const invalidTokens = [...promptTemplate.matchAll(/\{([^}]+)\}/g)].map(m => m[1].trim()).filter(t => !varNames.has(t))
        const hasInvalid = invalidTokens.length > 0

        function insertAtCursor(name: string) {
          const textarea = templateRef.current
          const token = '{' + name + '}'
          if (!textarea) {
            setPromptTemplate(t => t + token)
            return
          }
          const start = textarea.selectionStart ?? promptTemplate.length
          const end = textarea.selectionEnd ?? start
          const next = promptTemplate.slice(0, start) + token + promptTemplate.slice(end)
          setPromptTemplate(next)
          requestAnimationFrame(() => {
            textarea.selectionStart = textarea.selectionEnd = start + token.length
            textarea.focus()
          })
        }

        return (
          <section className="mb-10">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-lg font-semibold text-gray-800">Backstory Prompt Template</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  Write the persona brief that is passed to the LLM. Use{' '}
                  <code className="rounded bg-gray-100 px-1 text-xs">{'{variable_name}'}</code>{' '}
                  to insert a trait value. Click a chip to insert at your cursor position.
                </p>
              </div>
              <Button size="sm" loading={savingTemplate} disabled={hasInvalid} onClick={handleSaveTemplate}>
                Save Template
              </Button>
            </div>

            <Card>
              <CardBody>
                {/* Variable chips */}
                {variables.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {variables.map(v => {
                      const used = usedTokens.has(v.name)
                      return (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => insertAtCursor(v.name)}
                          className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                            used
                              ? 'bg-gray-100 text-gray-400 cursor-pointer hover:bg-indigo-50 hover:text-indigo-600'
                              : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                          }`}
                          title={'Insert {' + v.name + '}'}
                        >
                          {used ? '✓' : '+'} {'{' + v.name + '}'}
                        </button>
                      )
                    })}
                  </div>
                )}

                <textarea
                  ref={templateRef}
                  rows={10}
                  value={promptTemplate}
                  onChange={e => setPromptTemplate(e.target.value)}
                  placeholder={`Leave blank to use the default template, or write your own. Example:

You are a synthetic research participant.
You are {age} years old, {gender}, earning {income} per year.
You live in {location}.

Respond authentically as this person would.`}
                  className={`w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 resize-y ${
                    hasInvalid
                      ? 'border-red-400 focus:border-red-500 focus:ring-red-500'
                      : 'border-gray-300 focus:border-indigo-500 focus:ring-indigo-500'
                  }`}
                />

                {hasInvalid && (
                  <p className="mt-1.5 text-xs text-red-600">
                    Unknown placeholder{invalidTokens.length > 1 ? 's' : ''}:{' '}
                    {invalidTokens.map(t => <code key={t} className="rounded bg-red-50 px-1">{'{' + t + '}'}</code>
                    ).reduce<React.ReactNode[]>((acc, el, i) => i === 0 ? [el] : [...acc, ', ', el], [])}
                    {' '}— remove or match a variable name to save.
                  </p>
                )}

                <p className="mt-2 text-xs text-gray-400">
                  Leave blank to use the built-in default (formats all traits as a labelled list).
                </p>
              </CardBody>
            </Card>
          </section>
        )
      })()}

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
        {activeJob && (activeJob.status === 'running' || activeJob.status === 'stopped' || activeJob.status === 'failed' || activeJob.status === 'cancelled') && (
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
                    <Button size="sm" variant="secondary" loading={stoppingJob} onClick={handleStopJob}>
                      Pause
                    </Button>
                  )}
                  {activeJob.status === 'stopped' && (
                    <Button size="sm" loading={resumingJob} onClick={handleResumeJob}>
                      Resume
                    </Button>
                  )}
                  {(activeJob.status === 'running' || activeJob.status === 'stopped') && (
                    <Button size="sm" variant="danger" onClick={handleCancelJob}>
                      Cancel
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

          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Persona backstory</p>
            <div className="space-y-2">
              {([
                { value: 'none', label: 'No backstory', desc: 'Only trait values stored — fastest, no LLM cost.' },
                { value: 'template', label: 'Trait profile (no LLM)', desc: 'Formats all traits into a structured profile. Fast and free.' },
                { value: 'llm', label: 'AI-enriched narrative', desc: 'LLM writes a 150–250 word first-person backstory using the prompt template above.' },
              ] as const).map(opt => (
                <label key={opt.value} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${sampleForm.backstory_mode === opt.value ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
                  <input
                    type="radio"
                    name="sampleBackstoryMode"
                    value={opt.value}
                    checked={sampleForm.backstory_mode === opt.value}
                    onChange={() => setSampleForm(f => ({ ...f, backstory_mode: opt.value }))}
                    className="mt-0.5 text-indigo-600"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-800">{opt.label}</span>
                    <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={sampleForm.reuse_existing}
              onChange={e => setSampleForm(f => ({ ...f, reuse_existing: e.target.checked }))}
              className="rounded border-gray-300 text-indigo-600"
            />
            <span className="font-medium text-gray-700">Only generate what&apos;s missing (reuse existing)</span>
          </label>

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

          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Persona backstory</p>
            <div className="space-y-2">
              {([
                { value: 'none', label: 'No backstory', desc: 'Only trait values stored — fastest, no LLM cost.' },
                { value: 'template', label: 'Trait profile (no LLM)', desc: 'Formats all traits into a structured profile. Fast and free.' },
                { value: 'llm', label: 'AI-enriched narrative', desc: 'LLM writes a 150–250 word first-person backstory using the prompt template.' },
              ] as const).map(opt => (
                <label key={opt.value} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${freshForm.backstory_mode === opt.value ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
                  <input
                    type="radio"
                    name="freshBackstoryMode"
                    value={opt.value}
                    checked={freshForm.backstory_mode === opt.value}
                    onChange={() => setFreshForm(f => ({ ...f, backstory_mode: opt.value }))}
                    className="mt-0.5 text-indigo-600"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-800">{opt.label}</span>
                    <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

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
