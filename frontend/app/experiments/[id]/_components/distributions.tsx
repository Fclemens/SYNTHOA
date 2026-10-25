'use client'
import { distributionSummary } from '@/lib/utils'
import { ExperimentDistVariable, Question, DistributionConfig } from '@/lib/api'
import { Button } from '@/components/ui/Button'

// ── Distribution form (same pattern as audience variables) ───────────────────

export type DistType = 'normal' | 'truncated_normal' | 'log_normal' | 'uniform' | 'triangular' | 'beta' | 'exponential' | 'gamma' | 'categorical'
export interface CatOption { label: string; weight: number }
export interface VarFormState {
  name: string; var_type: 'continuous' | 'categorical'; sort_order: number
  dist_type: DistType; mean: string; std: string; real_mean: string; real_std: string
  min: string; max: string; mode: string; alpha: string; beta: string; lambda: string
  cat_options: CatOption[]
  round_to_int: boolean
}
export const defaultVarForm = (): VarFormState => ({
  // Most experiment variables are A/B stimuli (price, brand, message), so start categorical.
  name: '', var_type: 'categorical', sort_order: 0, dist_type: 'categorical', round_to_int: false,
  mean: '0', std: '1', real_mean: '50000', real_std: '20000',
  min: '0', max: '1', mode: '0.5', alpha: '2', beta: '5', lambda: '1',
  cat_options: [{ label: 'Option A', weight: 50 }, { label: 'Option B', weight: 50 }],
})

export function buildDistribution(form: VarFormState): DistributionConfig {
  const n = (s: string) => parseFloat(s) || 0
  if (form.var_type === 'categorical')
    return { type: 'categorical', options: form.cat_options.map(o => ({ label: o.label, weight: o.weight })) }
  const extra = form.round_to_int ? { round_to_int: true } : {}
  switch (form.dist_type) {
    case 'truncated_normal': return { type: 'truncated_normal', mean: n(form.mean), std: n(form.std), min: n(form.min), max: n(form.max), ...extra }
    case 'normal': return { type: 'normal', mean: n(form.mean), std: n(form.std), ...extra }
    case 'log_normal': return { type: 'log_normal', real_mean: n(form.real_mean), real_std: n(form.real_std) , ...extra }
    case 'uniform': return { type: 'uniform', min: n(form.min), max: n(form.max) , ...extra }
    case 'triangular': return { type: 'triangular', min: n(form.min), max: n(form.max), mode: n(form.mode) , ...extra }
    case 'beta': return { type: 'beta', alpha: n(form.alpha), beta: n(form.beta) , ...extra }
    case 'exponential': return { type: 'exponential', lambda: n(form.lambda) , ...extra }
    case 'gamma': return { type: 'gamma', alpha: n(form.alpha), beta: n(form.beta) , ...extra }
    default: return { type: form.dist_type }
  }
}

export function distSummary(v: ExperimentDistVariable): string {
  return distributionSummary(v.distribution as Record<string, unknown>)
}

export function VarFormFields({ form, setForm }: { form: VarFormState; setForm: React.Dispatch<React.SetStateAction<VarFormState>> }) {
  const set = (patch: Partial<VarFormState>) => setForm(f => ({ ...f, ...patch }))
  const inp = 'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500'
  const lbl = 'block text-sm font-medium text-gray-700'
  const row = 'grid grid-cols-2 gap-3'
  const contOpts = [
    { value: 'truncated_normal', label: 'Truncated normal (bounded)' }, { value: 'normal', label: 'Normal' }, { value: 'log_normal', label: 'Log-Normal' },
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
        <select value={form.var_type} onChange={e => set({ var_type: e.target.value as 'continuous' | 'categorical', dist_type: e.target.value === 'categorical' ? 'categorical' : 'truncated_normal' })} className={inp}>
          <option value="categorical">Categorical — pick one of several values (A/B test)</option>
          <option value="continuous">Numeric — sample from a distribution</option>
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
          {form.dist_type === 'truncated_normal' && (
            <div className="grid grid-cols-4 gap-3">
              <div><label className={lbl}>Mean</label><input type="number" value={form.mean} onChange={e => set({ mean: e.target.value })} className={inp} /></div>
              <div><label className={lbl}>Std dev</label><input type="number" min={0} value={form.std} onChange={e => set({ std: e.target.value })} className={inp} /></div>
              <div><label className={lbl}>Min</label><input type="number" value={form.min} onChange={e => set({ min: e.target.value })} className={inp} /></div>
              <div><label className={lbl}>Max</label><input type="number" value={form.max} onChange={e => set({ max: e.target.value })} className={inp} /></div>
            </div>
          )}
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
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.round_to_int} onChange={e => set({ round_to_int: e.target.checked })} />
            Round to whole numbers <span className="text-xs text-gray-500">(e.g. 29 instead of 28.73)</span>
          </label>
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

export function questionTypeColor(t: Question['question_type']): 'blue' | 'purple' | 'green' | 'indigo' {
  switch (t) {
    case 'scale': return 'blue'
    case 'single_choice': return 'indigo'
    case 'multiple_choice': return 'purple'
    default: return 'green'
  }
}
