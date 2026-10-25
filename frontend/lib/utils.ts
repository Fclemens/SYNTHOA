export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function fmtCost(usd: number | null | undefined): string {
  if (!usd) return '$0.0000'
  return `$${usd.toFixed(4)}`
}

export function fmtTokens(n: number | null | undefined): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function runStatusColor(status: string): 'gray' | 'blue' | 'green' | 'red' | 'yellow' {
  switch (status) {
    case 'completed': return 'green'
    case 'completed_with_errors': return 'yellow'
    case 'running':   return 'blue'
    case 'failed':    return 'red'
    case 'cancelled': return 'gray'
    default:          return 'yellow'
  }
}

export function runStatusLabel(status: string): string {
  return status === 'completed_with_errors' ? 'completed with errors' : status
}

/** Price lookup that tells the UI when a model has no pricing entry (cost would show $0). */
export function hasPricing(pricing: Record<string, unknown> | undefined, model: string): boolean {
  return !!pricing && model in pricing
}

export function taskStatusColor(status: string): 'gray' | 'blue' | 'green' | 'red' | 'yellow' {
  switch (status) {
    case 'completed': return 'green'
    case 'running':   return 'blue'
    case 'failed':    return 'red'
    case 'pending':   return 'yellow'
    default:          return 'gray'
  }
}

export function pct(completed: number, total: number): number {
  if (!total) return 0
  return Math.round((completed / total) * 100)
}

export function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

type RunLike = { id: string; run_number?: number | null; name?: string | null; experiment_name?: string | null }

/** Short human label for a run: its name, else "Run #3". */
export function runLabel(run: RunLike): string {
  if (run.name) return run.name
  return run.run_number ? `Run #${run.run_number}` : `Run ${run.id.slice(0, 6)}`
}

/** "Experiment name · Run #3" — for places where the experiment isn't already on screen. */
export function runTitle(run: RunLike): string {
  return run.experiment_name ? `${run.experiment_name} · ${runLabel(run)}` : runLabel(run)
}

/** What distinguishes a run from its siblings: size, model, extraction mode. */
export function runDetails(run: { total_tasks: number; model_pass1: string; execution_mode?: string; dual_extraction?: boolean }): string {
  return [
    `${run.total_tasks} persona${run.total_tasks !== 1 ? 's' : ''}`,
    run.model_pass1,
    run.execution_mode === 'dedicated' ? 'dedicated' : null,
    run.dual_extraction === false ? 'single extraction' : null,
  ].filter(Boolean).join(' · ')
}

/** Human label for a question type slug. */
export function questionTypeLabel(t: string): string {
  return ({ scale: 'Scale', single_choice: 'Single choice', multiple_choice: 'Multiple choice', open_ended: 'Open-ended' } as Record<string, string>)[t] ?? t
}

/** Readable one-line summary of a distribution config. */
export function distributionSummary(d: Record<string, unknown>): string {
  const n = (k: string) => {
    const v = d[k]
    return typeof v === 'number' ? (Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(+v.toFixed(3))) : String(v ?? '?')
  }
  const opts = (d.options as ({ label: string; weight?: number } | string)[] | undefined) ?? []
  const labels = opts.map(o => (typeof o === 'string' ? o : o.label))
  let s: string
  switch (d.type) {
    case 'categorical': case 'ordinal': {
      const ws = opts.map(o => (typeof o === 'string' ? 1 : (o.weight ?? 1)))
      const total = ws.reduce((a, b) => a + b, 0) || 1
      s = labels.map((l, i) => `${l} ${Math.round((ws[i] / total) * 100)}%`).join(' · ')
      break
    }
    case 'truncated_normal': s = `Truncated normal · mean ${n('mean')} · sd ${n('std')} · ${n('min')}–${n('max')}`; break
    case 'normal': s = `Normal · mean ${n('mean')} · sd ${n('std')}`; break
    case 'log_normal': s = `Log-normal · mean ${n('real_mean')} · sd ${n('real_std')}`; break
    case 'uniform': s = `Uniform · ${n('min')}–${n('max')}`; break
    case 'triangular': s = `Triangular · ${n('min')}–${n('max')} · mode ${n('mode')}`; break
    case 'beta': s = `Beta · α ${n('alpha')} · β ${n('beta')}`; break
    case 'gamma': s = `Gamma · shape ${n('alpha')} · scale ${n('beta')}`; break
    case 'exponential': s = `Exponential · λ ${n(d.lambda !== undefined ? 'lambda' : 'lambda_')}`; break
    case 'poisson': s = `Poisson · λ ${n(d.lambda !== undefined ? 'lambda' : 'lambda_')}`; break
    case 'weibull': s = `Weibull · shape ${n('shape')} · scale ${n('scale')}`; break
    default: s = String(d.type)
  }
  const extras: string[] = []
  const buckets = d.bucket_labels as string[] | undefined
  if (buckets?.length || d.normalize_labels) extras.push(`as ${buckets?.length ?? 5} labels`)
  else if (d.round_to_int) extras.push('whole numbers')
  return extras.length ? `${s} · ${extras.join(' · ')}` : s
}
