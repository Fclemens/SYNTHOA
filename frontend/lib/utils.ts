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
    case 'running':   return 'blue'
    case 'failed':    return 'red'
    case 'cancelled': return 'gray'
    default:          return 'yellow'
  }
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

export function calibrationColor(badge: string | null): 'green' | 'yellow' | 'gray' {
  switch (badge) {
    case 'calibrated':   return 'green'
    case 'directional':  return 'yellow'
    default:             return 'gray'
  }
}

export function pct(completed: number, total: number): number {
  if (!total) return 0
  return Math.round((completed / total) * 100)
}

export function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
