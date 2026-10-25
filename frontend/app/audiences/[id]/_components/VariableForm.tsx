'use client'


// ── Distribution type definitions ──────────────────────────────────────────

export type DistType = 'normal' | 'log_normal' | 'uniform' | 'triangular' | 'beta' | 'exponential' | 'gamma' | 'truncated_normal' | 'poisson' | 'weibull' | 'categorical' | 'ordinal'

export interface CatOption { label: string; weight: number }

export interface VarFormState {
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

export const DEFAULT_BUCKET_PRESETS: Record<number, string[]> = {
  2: ['Low', 'High'],
  3: ['Low', 'Medium', 'High'],
  4: ['Low', 'Medium-Low', 'Medium-High', 'High'],
  5: ['Very Low', 'Low', 'Medium', 'High', 'Very High'],
  6: ['Very Low', 'Low', 'Medium-Low', 'Medium-High', 'High', 'Very High'],
  7: ['Very Low', 'Low', 'Below Average', 'Average', 'Above Average', 'High', 'Very High'],
}

export const defaultForm = (): VarFormState => ({
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

export function buildDistribution(form: VarFormState): Record<string, unknown> {
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

export function VariableFormFields({
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
