/**
 * Lightweight statistical helpers for client-side analysis.
 * All functions are pure — no external deps.
 *
 * Goal: compute effect sizes, significance hints, and correlations
 * well enough to power badges / colour-coded UI. Not a substitute
 * for a proper stats package.
 */

// ── Distributions ─────────────────────────────────────────────────────────────

/** Normal CDF — Abramowitz & Stegun rational approximation. */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * absX)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX)
  return 0.5 * (1 + sign * erf)
}

/**
 * Two-tailed p-value from a t-statistic.
 * For df >= 20 uses normal approximation (accurate enough for UI hints).
 * For small df uses Fisher's series expansion via the incomplete beta fn.
 */
export function tPValue(t: number, df: number): number {
  if (!isFinite(t) || df <= 0) return 1
  if (df >= 20) return 2 * (1 - normalCdf(Math.abs(t)))
  // Incomplete beta approximation for smaller df.
  const x = df / (df + t * t)
  return regIncBeta(x, df / 2, 0.5)
}

/**
 * Two-tailed p-value from an F-statistic (one-way ANOVA).
 * Approximation: uses incomplete beta on x = df2 / (df2 + df1 * F).
 */
export function fPValue(f: number, df1: number, df2: number): number {
  if (!isFinite(f) || f <= 0 || df1 <= 0 || df2 <= 0) return 1
  const x = df2 / (df2 + df1 * f)
  return regIncBeta(x, df2 / 2, df1 / 2)
}

/**
 * Chi-square p-value (upper-tail).
 * Uses the regularised upper incomplete gamma via continued fraction / series.
 */
export function chiSquarePValue(chi2: number, df: number): number {
  if (!isFinite(chi2) || chi2 <= 0 || df <= 0) return 1
  return 1 - regLowerIncGamma(df / 2, chi2 / 2)
}

// ── Special functions ─────────────────────────────────────────────────────────

/** Regularised incomplete beta function I_x(a, b). */
function regIncBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  if (x < (a + 1) / (a + b + 2)) {
    return bt * betaContFrac(x, a, b) / a
  }
  return 1 - bt * betaContFrac(1 - x, b, a) / b
}

function betaContFrac(x: number, a: number, b: number): number {
  const maxIter = 200
  const eps = 3e-7
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < 1e-30) d = 1e-30
  d = 1 / d
  let h = d
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + aa / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    h *= d * c
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + aa / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < eps) break
  }
  return h
}

/** Lanczos log-gamma. */
function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.001208650973866179, -5.395239384953e-6]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) {
    y += 1
    ser += c[j] / y
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x)
}

/** Regularised lower incomplete gamma P(a, x). */
function regLowerIncGamma(a: number, x: number): number {
  if (x <= 0) return 0
  if (x < a + 1) return gammaSeries(a, x)
  return 1 - gammaContFrac(a, x)
}

function gammaSeries(a: number, x: number): number {
  const maxIter = 200
  const eps = 3e-7
  let ap = a
  let sum = 1 / a
  let del = sum
  for (let n = 1; n <= maxIter; n++) {
    ap += 1
    del *= x / ap
    sum += del
    if (Math.abs(del) < Math.abs(sum) * eps) break
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a))
}

function gammaContFrac(a: number, x: number): number {
  const maxIter = 200
  const eps = 3e-7
  let b = x + 1 - a
  let c = 1 / 1e-30
  let d = 1 / b
  let h = d
  for (let i = 1; i <= maxIter; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = b + an / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < eps) break
  }
  return h * Math.exp(-x + a * Math.log(x) - logGamma(a))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

export interface MeanCompare {
  /** Effect size (Cohen's d) — null when undefined. */
  d: number | null
  /** Two-tailed p-value (NaN when undefined). */
  p: number
  /** t statistic. */
  t: number
  /** Welch's degrees of freedom. */
  df: number
  nA: number
  nB: number
  meanA: number
  meanB: number
}

/** Welch's two-sample t-test with Cohen's d. */
export function welchTTest(a: number[], b: number[]): MeanCompare | null {
  if (a.length < 2 || b.length < 2) return null
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length
  const variance = (xs: number[], m: number) => xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1)
  const mA = mean(a); const mB = mean(b)
  const vA = variance(a, mA); const vB = variance(b, mB)
  const nA = a.length; const nB = b.length
  const se = Math.sqrt(vA / nA + vB / nB)
  if (se === 0 || !isFinite(se)) return null
  const t = (mA - mB) / se
  const df = (vA / nA + vB / nB) ** 2 / ((vA / nA) ** 2 / (nA - 1) + (vB / nB) ** 2 / (nB - 1))
  const pooledSd = Math.sqrt(((nA - 1) * vA + (nB - 1) * vB) / (nA + nB - 2))
  const d = pooledSd > 0 ? (mA - mB) / pooledSd : null
  return { d, p: tPValue(t, df), t, df, nA, nB, meanA: mA, meanB: mB }
}

export interface GroupComparison {
  /** Overall F statistic (or t² for 2 groups). */
  f: number
  /** Overall p-value across all groups. */
  p: number
  /** Eta-squared effect size (0-1). */
  etaSquared: number
  nGroups: number
  nTotal: number
}

/** One-way ANOVA across N groups. */
export function oneWayANOVA(groups: number[][]): GroupComparison | null {
  const nonEmpty = groups.filter(g => g.length > 0)
  if (nonEmpty.length < 2) return null
  const nTotal = nonEmpty.reduce((s, g) => s + g.length, 0)
  if (nTotal <= nonEmpty.length) return null
  const groupMeans = nonEmpty.map(g => g.reduce((s, v) => s + v, 0) / g.length)
  const grandMean = nonEmpty.flat().reduce((s, v) => s + v, 0) / nTotal
  let ssBetween = 0
  for (let i = 0; i < nonEmpty.length; i++) {
    ssBetween += nonEmpty[i].length * (groupMeans[i] - grandMean) ** 2
  }
  let ssWithin = 0
  for (let i = 0; i < nonEmpty.length; i++) {
    for (const v of nonEmpty[i]) ssWithin += (v - groupMeans[i]) ** 2
  }
  const dfBetween = nonEmpty.length - 1
  const dfWithin = nTotal - nonEmpty.length
  if (ssWithin === 0 || dfWithin <= 0) return null
  const msBetween = ssBetween / dfBetween
  const msWithin = ssWithin / dfWithin
  const f = msBetween / msWithin
  const total = ssBetween + ssWithin
  const etaSquared = total > 0 ? ssBetween / total : 0
  return { f, p: fPValue(f, dfBetween, dfWithin), etaSquared, nGroups: nonEmpty.length, nTotal }
}

export interface CorrelationResult {
  r: number
  n: number
  p: number
}

/** Pearson correlation with two-tailed p-value. */
export function pearsonCorrelation(xs: number[], ys: number[]): CorrelationResult | null {
  if (xs.length !== ys.length || xs.length < 3) return null
  const n = xs.length
  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  let num = 0, dx2 = 0, dy2 = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx; const dy = ys[i] - my
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy
  }
  const denom = Math.sqrt(dx2 * dy2)
  if (denom === 0 || !isFinite(denom)) return null
  const r = num / denom
  const t = r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r))
  return { r, n, p: tPValue(t, n - 2) }
}

export interface CramersResult {
  v: number
  chi2: number
  p: number
  n: number
}

/** Cramér's V for categorical × categorical association. */
export function cramersV(xs: (string | number)[], ys: (string | number)[]): CramersResult | null {
  if (xs.length !== ys.length || xs.length < 4) return null
  const rows = Array.from(new Set(xs.map(String)))
  const cols = Array.from(new Set(ys.map(String)))
  if (rows.length < 2 || cols.length < 2) return null
  const n = xs.length
  const rowIdx: Record<string, number> = {}
  const colIdx: Record<string, number> = {}
  rows.forEach((r, i) => rowIdx[r] = i)
  cols.forEach((c, i) => colIdx[c] = i)
  const table: number[][] = Array.from({ length: rows.length }, () => Array(cols.length).fill(0))
  const rowTot = Array(rows.length).fill(0)
  const colTot = Array(cols.length).fill(0)
  for (let i = 0; i < n; i++) {
    const r = rowIdx[String(xs[i])]; const c = colIdx[String(ys[i])]
    table[r][c] += 1; rowTot[r] += 1; colTot[c] += 1
  }
  let chi2 = 0
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < cols.length; j++) {
      const expected = (rowTot[i] * colTot[j]) / n
      if (expected > 0) chi2 += ((table[i][j] - expected) ** 2) / expected
    }
  }
  const minDim = Math.min(rows.length, cols.length) - 1
  const v = minDim > 0 ? Math.sqrt(chi2 / (n * minDim)) : 0
  const df = (rows.length - 1) * (cols.length - 1)
  return { v, chi2, p: chiSquarePValue(chi2, df), n }
}

// ── Badges / thresholds ───────────────────────────────────────────────────────

export interface SignificanceBadge {
  label: string
  /** Tailwind colour class hints. */
  bg: string
  fg: string
  /** True if p < 0.05 (or strong-enough effect for descriptive fallback). */
  significant: boolean
}

/** Produce a user-facing badge from a p-value. */
export function pBadge(p: number): SignificanceBadge {
  if (!isFinite(p) || isNaN(p)) return { label: 'n/a', bg: 'bg-gray-100', fg: 'text-gray-500', significant: false }
  if (p < 0.001) return { label: 'p < 0.001', bg: 'bg-emerald-100', fg: 'text-emerald-700', significant: true }
  if (p < 0.01) return { label: 'p < 0.01', bg: 'bg-emerald-50', fg: 'text-emerald-700', significant: true }
  if (p < 0.05) return { label: 'p < 0.05', bg: 'bg-teal-50', fg: 'text-teal-700', significant: true }
  if (p < 0.1) return { label: 'p < 0.1', bg: 'bg-amber-50', fg: 'text-amber-700', significant: false }
  return { label: 'n.s.', bg: 'bg-gray-100', fg: 'text-gray-500', significant: false }
}

/** Label Cohen's d strength. */
export function cohenLabel(d: number | null): string {
  if (d === null || !isFinite(d)) return ''
  const a = Math.abs(d)
  if (a < 0.2) return 'negligible'
  if (a < 0.5) return 'small'
  if (a < 0.8) return 'medium'
  return 'large'
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Convert arbitrary values to numeric array, dropping non-numerics. */
export function toNumbers(vals: unknown[]): number[] {
  const out: number[] = []
  for (const v of vals) {
    if (v === null || v === undefined || v === '') continue
    const n = typeof v === 'number' ? v : parseFloat(String(v))
    if (!isNaN(n) && isFinite(n)) out.push(n)
  }
  return out
}

/** True if all defined values can parse to finite numbers. */
export function isNumericArray(vals: unknown[]): boolean {
  let count = 0
  for (const v of vals) {
    if (v === null || v === undefined || v === '') continue
    const n = typeof v === 'number' ? v : parseFloat(String(v))
    if (isNaN(n) || !isFinite(n)) return false
    count += 1
  }
  return count > 0
}

/** Bucket a numeric vector into tertile labels. */
export function tertileBuckets(values: number[]): { q1: number; q2: number; label: (v: number) => string } {
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length / 3)]
  const q2 = sorted[Math.floor(sorted.length * 2 / 3)]
  return {
    q1, q2,
    label: (v: number) => v <= q1 ? `Low (≤${q1})` : v <= q2 ? `Mid (${q1}–${q2})` : `High (>${q2})`,
  }
}
