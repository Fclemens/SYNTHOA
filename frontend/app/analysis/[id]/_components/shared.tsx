'use client'
import { Respondent } from '@/lib/api'
import { oneWayANOVA, pearsonCorrelation, cramersV, pBadge, toNumbers, isNumericArray } from '@/lib/stats'

// ── Spinner ────────────────────────────────────────────────────────────────────
export function Spin({ size = 4 }: { size?: number }) {
  return (
    <svg className={`h-${size} w-${size} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  )
}

// ── Significance pill ─────────────────────────────────────────────────────────
export function SigBadge({ p, effect, effectLabel }: { p: number; effect?: number | null; effectLabel?: string }) {
  const b = pBadge(p)
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${b.bg} ${b.fg}`}>
      {b.label}
      {effect !== undefined && effect !== null && isFinite(effect) && (
        <span className="opacity-70">
          · {effectLabel ?? 'd'}={effect.toFixed(2)}
        </span>
      )}
    </span>
  )
}


// ── Simple stat helpers (for Variables + Segments tabs) ───────────────────────

export function computeNumericStats(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)]
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
  return { mean: +mean.toFixed(2), median: +median.toFixed(2), std: +std.toFixed(2), min: sorted[0], max: sorted[sorted.length - 1], n: values.length }
}

export function computeDistribution(values: (string | boolean)[]) {
  const counts: Record<string, number> = {}
  for (const v of values) { const k = String(v); counts[k] = (counts[k] ?? 0) + 1 }
  const total = values.length
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ label: k, count: c, pct: +(c / total * 100).toFixed(1) }))
}

export function MiniStats({ values, type }: { values: unknown[]; type: string }) {
  if (!values.length) return <span className="text-xs text-gray-400">no data</span>
  const isNumeric = type === 'scale' || type === 'integer' || type === 'float' || type === 'number'
  if (isNumeric) {
    const nums = values.map(v => parseFloat(String(v))).filter(n => !isNaN(n))
    const stats = computeNumericStats(nums)
    if (!stats) return <span className="text-xs text-gray-400">—</span>
    return (
      <div className="text-xs">
        <span className="font-semibold text-indigo-600">{stats.mean}</span>
        <span className="text-gray-400"> mean · </span>
        <span className="text-gray-600">{stats.median} med · ±{stats.std}</span>
        <span className="text-gray-400"> · n={stats.n}</span>
      </div>
    )
  }
  if (type === 'boolean') {
    const trueCount = values.filter(v => v === true || String(v).toLowerCase() === 'true').length
    const pct = +(trueCount / values.length * 100).toFixed(1)
    return <div className="text-xs"><span className="font-semibold text-green-600">{pct}%</span><span className="text-gray-400"> true · n={values.length}</span></div>
  }
  // categorical / string
  const dist = computeDistribution(values as (string | boolean)[])
  const top3 = dist.slice(0, 3)
  return (
    <div className="space-y-0.5">
      {top3.map(d => (
        <div key={d.label} className="flex items-center gap-2 text-xs">
          <span className="truncate max-w-[140px] text-gray-700">{d.label}</span>
          <span className="text-gray-400">{d.pct}%</span>
        </div>
      ))}
      {dist.length > 3 && <div className="text-xs text-gray-400">+{dist.length - 3} more</div>}
    </div>
  )
}

// ── Transcript parsing ────────────────────────────────────────────────────────

export interface Turn {
  speaker: 'interviewer' | 'respondent' | 'other'
  text: string
}

export function parseTranscript(raw: string): Turn[] {
  if (!raw) return []
  const lines = raw.split('\n')
  const turns: Turn[] = []
  let cur: Turn | null = null
  const interviewerRe = /^(\s*)(interviewer|moderator|researcher|q\d*\.?|question\s*\d*[:.]?)\s*[:.\-]/i
  const respondentRe = /^(\s*)(persona|respondent|participant|a\d*\.?|answer\s*\d*[:.]?|you)\s*[:.\-]/i
  for (const line of lines) {
    if (interviewerRe.test(line)) {
      if (cur) turns.push(cur)
      cur = { speaker: 'interviewer', text: line.replace(interviewerRe, '').trim() }
    } else if (respondentRe.test(line)) {
      if (cur) turns.push(cur)
      cur = { speaker: 'respondent', text: line.replace(respondentRe, '').trim() }
    } else {
      if (cur) {
        cur.text += (cur.text ? '\n' : '') + line.trim()
      } else if (line.trim()) {
        cur = { speaker: 'other', text: line.trim() }
      }
    }
  }
  if (cur) turns.push(cur)
  return turns.filter(t => t.text)
}

// ── Driver analysis ───────────────────────────────────────────────────────────

export interface DriverScore {
  traitKey: string
  /** Absolute effect size / correlation magnitude, 0-1 */
  strength: number
  /** Signed direction (+/-) for correlations; 0 for categorical. */
  direction: number
  p: number
  type: 'pearson' | 'eta' | 'cramers'
  /** Human-readable metric value. */
  valueLabel: string
}

export function computeDrivers(
  respondents: Respondent[],
  traitKeys: string[],
  fieldKey: string,
  fieldType: string,
): DriverScore[] {
  const results: DriverScore[] = []
  const outputValues = respondents.map(r => r.extracted_json[fieldKey])
  const isNumericOutput = ['scale', 'integer', 'float', 'number'].includes(fieldType)

  for (const trait of traitKeys) {
    const traitValues = respondents.map(r => r.persona_traits[trait])
    // pair them up, dropping nulls
    const pairs: { t: unknown; o: unknown }[] = []
    for (let i = 0; i < respondents.length; i++) {
      if (traitValues[i] === null || traitValues[i] === undefined || traitValues[i] === '') continue
      if (outputValues[i] === null || outputValues[i] === undefined || outputValues[i] === '') continue
      pairs.push({ t: traitValues[i], o: outputValues[i] })
    }
    if (pairs.length < 4) continue

    const ts = pairs.map(p => p.t)
    const os = pairs.map(p => p.o)
    const traitIsNumeric = isNumericArray(ts)

    if (traitIsNumeric && isNumericOutput) {
      const nums1 = toNumbers(ts)
      const nums2 = toNumbers(os)
      const corr = pearsonCorrelation(nums1, nums2)
      if (corr && isFinite(corr.r)) {
        results.push({
          traitKey: trait,
          strength: Math.abs(corr.r),
          direction: Math.sign(corr.r),
          p: corr.p,
          type: 'pearson',
          valueLabel: `r = ${corr.r.toFixed(2)}`,
        })
      }
    } else if (isNumericOutput) {
      // categorical trait × numeric outcome → one-way ANOVA η
      const groups: Record<string, number[]> = {}
      for (const { t, o } of pairs) {
        const k = String(t)
        if (!groups[k]) groups[k] = []
        const n = parseFloat(String(o))
        if (!isNaN(n)) groups[k].push(n)
      }
      const result = oneWayANOVA(Object.values(groups))
      if (result) {
        const eta = Math.sqrt(result.etaSquared)
        results.push({
          traitKey: trait,
          strength: eta,
          direction: 0,
          p: result.p,
          type: 'eta',
          valueLabel: `η = ${eta.toFixed(2)}`,
        })
      }
    } else {
      // categorical output → Cramér's V (trait may be numeric-cast-to-string)
      const v = cramersV(ts.map(x => String(x)), os.map(x => String(x)))
      if (v) {
        results.push({
          traitKey: trait,
          strength: v.v,
          direction: 0,
          p: v.p,
          type: 'cramers',
          valueLabel: `V = ${v.v.toFixed(2)}`,
        })
      }
    }
  }
  return results.sort((a, b) => b.strength - a.strength)
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

export function SimpleMarkdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none text-gray-700">
      {text.split('\n').map((line, i) => {
        if (line.startsWith('### ')) return <h3 key={i} className="text-sm font-bold text-gray-900 mt-4 mb-1">{line.slice(4)}</h3>
        if (line.startsWith('## ')) return <h2 key={i} className="text-base font-bold text-gray-900 mt-5 mb-2">{line.slice(3)}</h2>
        if (line.startsWith('# ')) return <h1 key={i} className="text-lg font-bold text-gray-900 mt-4 mb-2">{line.slice(2)}</h1>
        if (line.startsWith('- ') || line.startsWith('• ')) return (
          <div key={i} className="flex gap-2 mb-1"><span className="text-gray-400 flex-shrink-0 mt-0.5">•</span><span>{line.slice(2)}</span></div>
        )
        if (line.trim() === '') return <div key={i} className="h-3" />
        return <p key={i} className="mb-1.5 leading-relaxed">{line}</p>
      })}
    </div>
  )
}
