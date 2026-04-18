'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  api,
  RunAnalysisSummary,
  FieldSummary,
  FieldSummaryScale,
  FieldSummaryChoice,
  FieldSummaryBoolean,
  FieldSummaryText,
  DeepDiveResult,
  DeepDiveRequest,
  AnalysisType,
  ContextMode,
  Respondent,
  TextAnalyticsResult,
} from '@/lib/api'
import { fmtCost } from '@/lib/utils'
import {
  welchTTest,
  oneWayANOVA,
  pearsonCorrelation,
  cramersV,
  pBadge,
  cohenLabel,
  toNumbers,
  isNumericArray,
  tertileBuckets,
} from '@/lib/stats'
import PromptEditorModal from '@/components/PromptEditorModal'

type Tab = 'results' | 'transcripts' | 'variables' | 'segments' | 'report'

// ── Spinner ────────────────────────────────────────────────────────────────────
function Spin({ size = 4 }: { size?: number }) {
  return (
    <svg className={`h-${size} w-${size} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  )
}

// ── Significance pill ─────────────────────────────────────────────────────────
function SigBadge({ p, effect, effectLabel }: { p: number; effect?: number | null; effectLabel?: string }) {
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

// ── Field visualizations ──────────────────────────────────────────────────────

function ScaleCard({ field }: { field: FieldSummaryScale }) {
  const range = (field.max ?? 0) - (field.min ?? 0)
  const mean = field.mean ?? 0
  const pct = range > 0 ? Math.round(((mean - (field.min ?? 0)) / range) * 100) : 50
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-6">
        <div className="text-center">
          <div className="text-3xl font-bold text-indigo-600">{field.mean ?? '—'}</div>
          <div className="text-xs text-gray-400 mt-0.5">mean</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold text-gray-700">{field.median ?? '—'}</div>
          <div className="text-xs text-gray-400 mt-0.5">median</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold text-gray-700">±{field.std ?? '—'}</div>
          <div className="text-xs text-gray-400 mt-0.5">std dev</div>
        </div>
        <div className="text-center">
          <div className="text-sm text-gray-500">{field.min}–{field.max}</div>
          <div className="text-xs text-gray-400 mt-0.5">range</div>
        </div>
      </div>
      <div className="relative h-2 rounded-full bg-gray-100">
        <div className="absolute left-0 top-0 h-2 rounded-full bg-indigo-400" style={{ width: `${pct}%` }} />
      </div>
      {field.histogram && field.histogram.length > 0 && (
        <div className="flex items-end gap-0.5 h-12">
          {field.histogram.map((b, i) => {
            const maxCount = Math.max(...field.histogram.map(x => x.count), 1)
            const h = Math.max(4, Math.round((b.count / maxCount) * 48))
            return (
              <div key={i} className="flex-1 group relative">
                <div className="w-full rounded-t bg-indigo-200 group-hover:bg-indigo-400 transition-colors" style={{ height: `${h}px` }} title={`${b.label}: ${b.count}`} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ChoiceCard({ field }: { field: FieldSummaryChoice }) {
  const entries = Object.entries(field.distribution)
  const maxPct = Math.max(...entries.map(([, v]) => v.pct), 1)
  return (
    <div className="space-y-2">
      {entries.map(([opt, v]) => (
        <div key={opt} className="space-y-0.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-700 font-medium truncate max-w-[60%]">{opt}</span>
            <span className="text-gray-500">{v.pct}% <span className="text-gray-400">({v.count})</span></span>
          </div>
          <div className="relative h-1.5 rounded-full bg-gray-100">
            <div className="absolute left-0 top-0 h-1.5 rounded-full bg-indigo-400" style={{ width: `${(v.pct / maxPct) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function BooleanCard({ field }: { field: FieldSummaryBoolean }) {
  const truePct = field.true_pct
  const falsePct = 100 - truePct
  return (
    <div className="space-y-3">
      <div className="flex gap-4">
        <div className="flex-1 rounded-lg bg-green-50 border border-green-200 p-3 text-center">
          <div className="text-2xl font-bold text-green-600">{truePct}%</div>
          <div className="text-xs text-green-600 mt-0.5">True ({field.true_count})</div>
        </div>
        <div className="flex-1 rounded-lg bg-gray-50 border border-gray-200 p-3 text-center">
          <div className="text-2xl font-bold text-gray-500">{falsePct.toFixed(1)}%</div>
          <div className="text-xs text-gray-500 mt-0.5">False ({field.false_count})</div>
        </div>
      </div>
      <div className="relative h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className="absolute left-0 top-0 h-2 bg-green-400 rounded-full" style={{ width: `${truePct}%` }} />
      </div>
    </div>
  )
}

// ── Text analytics card (enhanced TextCard) ──────────────────────────────────

function sentimentColor(s: string): string {
  if (s === 'positive') return 'bg-emerald-400'
  if (s === 'negative') return 'bg-rose-400'
  return 'bg-gray-300'
}

function TextCard({ field, runId, confidenceThreshold }: {
  field: FieldSummaryText; runId: string; confidenceThreshold: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [analytics, setAnalytics] = useState<TextAnalyticsResult | null>(null)
  const [loadingAnalytics, setLoadingAnalytics] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const answers = field.answers ?? []
  const showCount = expanded ? answers.length : 5

  const sentimentByIndex = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of analytics?.per_response_sentiment ?? []) m.set(s.index, s.sentiment)
    return m
  }, [analytics])

  const handleAnalyze = async () => {
    setLoadingAnalytics(true); setError(null)
    try {
      setAnalytics(await api.textAnalytics(runId, field.key, confidenceThreshold))
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed') }
    finally { setLoadingAnalytics(false) }
  }

  return (
    <div className="space-y-3">
      {/* Text analytics button / result */}
      {!analytics ? (
        <div className="flex items-center gap-2">
          <button onClick={handleAnalyze} disabled={loadingAnalytics || answers.length === 0}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium bg-teal-50 text-teal-700 hover:bg-teal-100 border border-teal-200 disabled:opacity-50 transition-colors">
            {loadingAnalytics ? <Spin size={3} /> : <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
            Extract themes & sentiment
          </button>
          {error && <span className="text-xs text-red-500">{error}</span>}
        </div>
      ) : (
        <div className="space-y-2.5 rounded-lg border border-teal-100 bg-teal-50/40 p-3">
          {/* Sentiment bar */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-gray-600">Overall sentiment</span>
              <span className="text-xs text-gray-400">
                {analytics.sentiment.positive_pct}% / {analytics.sentiment.neutral_pct}% / {analytics.sentiment.negative_pct}%
              </span>
            </div>
            <div className="flex h-2 rounded-full overflow-hidden bg-gray-100">
              <div className="bg-emerald-400" style={{ width: `${analytics.sentiment.positive_pct}%` }} title={`Positive ${analytics.sentiment.positive_pct}%`} />
              <div className="bg-gray-300" style={{ width: `${analytics.sentiment.neutral_pct}%` }} title={`Neutral ${analytics.sentiment.neutral_pct}%`} />
              <div className="bg-rose-400" style={{ width: `${analytics.sentiment.negative_pct}%` }} title={`Negative ${analytics.sentiment.negative_pct}%`} />
            </div>
          </div>
          {/* Themes */}
          {analytics.themes.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-600 mb-1.5">Themes</div>
              <div className="flex flex-wrap gap-1.5">
                {analytics.themes.map(t => (
                  <div key={t.name}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white border border-teal-200 px-2.5 py-1 text-xs"
                    title={t.description}>
                    <span className="font-medium text-teal-700">{t.name}</span>
                    <span className="text-gray-400">{t.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <button onClick={handleAnalyze}
            className="text-xs text-teal-600 hover:text-teal-700">
            {loadingAnalytics ? 'Re-running…' : 'Re-run analytics'}
          </button>
        </div>
      )}

      {/* Answers list */}
      {answers.length > 0 && (
        <div>
          <p className="text-xs text-gray-400 mb-1.5">Sample responses</p>
          <div className="space-y-1.5">
            {answers.slice(0, showCount).map((a, i) => {
              const sent = sentimentByIndex.get(i + 1)
              return (
                <div key={i} className="flex items-start gap-2 rounded bg-gray-50 px-3 py-2">
                  {sent && <span className={`mt-1 h-2 w-2 rounded-full flex-shrink-0 ${sentimentColor(sent)}`} title={sent} />}
                  <span className="text-xs text-gray-600 leading-relaxed flex-1">{a}</span>
                </div>
              )
            })}
          </div>
          {answers.length > 5 && (
            <button onClick={() => setExpanded(!expanded)} className="mt-2 text-xs text-indigo-500 hover:text-indigo-700">
              {expanded ? 'Show less' : `Show all ${answers.length} responses`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Field card ────────────────────────────────────────────────────────────────

function FieldCard({ field, runId, confidenceThreshold, insightsModel, onSummaryGenerated }: {
  field: FieldSummary; runId: string; confidenceThreshold: number
  insightsModel: string; onSummaryGenerated: (key: string, summary: string) => void
}) {
  const ftype = field.type
  const label = field.description || field.key
  const isText = ftype === 'open_ended' || ftype === 'text' || ftype === 'string'
  const promptName = isText ? 'summarize_open_ended' : 'summarize_field_stats'
  const [summarizing, setSummarizing] = useState(false)
  const [sumError, setSumError] = useState<string | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const llmSummary = (field as FieldSummaryText).llm_summary

  const handleSummarize = async () => {
    setSummarizing(true); setSumError(null)
    try {
      const res = await api.summarizeField(runId, field.key, confidenceThreshold)
      onSummaryGenerated(field.key, res.llm_summary)
    } catch (e: unknown) { setSumError(e instanceof Error ? e.message : 'Error') }
    finally { setSummarizing(false) }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{label}</h3>
          <p className="text-xs text-gray-400 font-mono">{field.key}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-gray-400">{field.n} resp.</span>
          {field.missing > 0 && <span className="text-xs text-amber-500">{field.missing} missing</span>}
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 font-mono">{ftype}</span>
        </div>
      </div>
      <div className="mt-4">
        {(ftype === 'scale' || ftype === 'number' || ftype === 'integer' || ftype === 'float') && <ScaleCard field={field as FieldSummaryScale} />}
        {(ftype === 'multiple_choice' || (!['scale','number','integer','float','boolean','open_ended','text','string'].includes(ftype))) && <ChoiceCard field={field as FieldSummaryChoice} />}
        {ftype === 'boolean' && <BooleanCard field={field as FieldSummaryBoolean} />}
        {isText && <TextCard field={field as FieldSummaryText} runId={runId} confidenceThreshold={confidenceThreshold} />}
      </div>
      <div className="mt-4 pt-3 border-t border-gray-100 space-y-2">
        {llmSummary && (
          <div className="rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2.5">
            <span className="text-xs font-medium text-indigo-600">AI Summary</span>
            <p className="text-xs text-gray-700 leading-relaxed mt-1">{llmSummary}</p>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={handleSummarize} disabled={summarizing}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {summarizing ? <Spin size={3} /> : null}
            {llmSummary ? 'Re-generate' : 'Generate AI summary'}
          </button>
          <button onClick={() => setPromptOpen(true)} className="rounded-lg px-2 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
            Edit prompt
          </button>
          {sumError && <span className="text-xs text-red-500">{sumError}</span>}
          <span className="text-xs text-gray-300 font-mono ml-auto">{insightsModel}</span>
        </div>
      </div>
      <PromptEditorModal open={promptOpen} promptName={promptName} title={isText ? 'Edit: Open-ended Summary Prompt' : 'Edit: Stats Summary Prompt'} onClose={() => setPromptOpen(false)} />
    </div>
  )
}

// ── Simple stat helpers (for Variables + Segments tabs) ───────────────────────

function computeNumericStats(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)]
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
  return { mean: +mean.toFixed(2), median: +median.toFixed(2), std: +std.toFixed(2), min: sorted[0], max: sorted[sorted.length - 1], n: values.length }
}

function computeDistribution(values: (string | boolean)[]) {
  const counts: Record<string, number> = {}
  for (const v of values) { const k = String(v); counts[k] = (counts[k] ?? 0) + 1 }
  const total = values.length
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ label: k, count: c, pct: +(c / total * 100).toFixed(1) }))
}

function MiniStats({ values, type }: { values: unknown[]; type: string }) {
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

interface Turn {
  speaker: 'interviewer' | 'respondent' | 'other'
  text: string
}

function parseTranscript(raw: string): Turn[] {
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

interface DriverScore {
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

function computeDrivers(
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

function SimpleMarkdown({ text }: { text: string }) {
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AnalysisDetailPage() {
  const params = useParams()
  const runId = params.id as string

  const [tab, setTab] = useState<Tab>('results')
  const [summary, setSummary] = useState<RunAnalysisSummary | null>(null)
  const [respondents, setRespondents] = useState<Respondent[] | null>(null)
  const [loadingSummary, setLoadingSummary] = useState(true)
  const [loadingRespondents, setLoadingRespondents] = useState(false)
  const [confidenceThreshold, setConfidenceThreshold] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [runInfo, setRunInfo] = useState<{ created_at: string; model_pass1: string; total_cost_usd: number; experiment_id: string } | null>(null)
  const [insightsModel, setInsightsModel] = useState<string>('…')

  const fetchSummary = useCallback(async (threshold: number) => {
    setLoadingSummary(true); setError(null)
    try {
      const [s, run] = await Promise.all([api.getRunSummary(runId, threshold), api.getRun(runId)])
      setSummary(s)
      setRunInfo({ created_at: run.created_at, model_pass1: run.model_pass1, total_cost_usd: run.total_cost_usd, experiment_id: run.experiment_id })
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed to load') }
    finally { setLoadingSummary(false) }
  }, [runId])

  const fetchRespondents = useCallback(async () => {
    if (respondents) return
    setLoadingRespondents(true)
    try { setRespondents(await api.getRespondents(runId)) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed to load respondents') }
    finally { setLoadingRespondents(false) }
  }, [runId, respondents])

  useEffect(() => { api.getSettings().then(s => setInsightsModel(s.effective_insights_model)).catch(() => {}) }, [])
  useEffect(() => { fetchSummary(confidenceThreshold) }, [fetchSummary, confidenceThreshold])
  useEffect(() => {
    if (tab === 'transcripts' || tab === 'variables' || tab === 'segments' || tab === 'results') fetchRespondents()
  }, [tab, fetchRespondents])

  const handleSummaryGenerated = (key: string, text: string) => {
    setSummary(prev => {
      if (!prev) return prev
      return { ...prev, fields: { ...prev.fields, [key]: { ...prev.fields[key], llm_summary: text } as FieldSummary } }
    })
  }

  // Detect if run has injected variables
  const hasInjectedVars = respondents && respondents.some(r => Object.keys(r.injected_vars).length > 0)
  const injectedVarKeys = respondents ? Array.from(new Set(respondents.flatMap(r => Object.keys(r.injected_vars)))) : []
  const outputFieldKeys = summary ? Object.keys(summary.fields) : []
  const schemaFields = summary ? Object.values(summary.fields) : []

  const tabs: { key: Tab; label: string }[] = [
    { key: 'results', label: 'Results' },
    { key: 'transcripts', label: `Transcripts${respondents ? ` (${respondents.length})` : ''}` },
    ...(hasInjectedVars ? [{ key: 'variables' as Tab, label: 'Variables' }] : []),
    { key: 'segments', label: 'Segments' },
    { key: 'report', label: 'AI Report' },
  ]

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <Link href="/analysis" className="text-sm text-gray-400 hover:text-gray-600 transition-colors">← Analysis</Link>
          <h1 className="text-xl font-bold text-gray-900 mt-1">Run {runId.slice(0, 8)}</h1>
          {runInfo && (
            <p className="text-xs text-gray-400 mt-0.5">
              {new Date(runInfo.created_at).toLocaleString()} · {runInfo.model_pass1} · {fmtCost(runInfo.total_cost_usd)}
            </p>
          )}
        </div>
        <a href={api.exportAnalysisPdf(runId)} target="_blank" rel="noreferrer"
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Export PDF
        </a>
      </div>

      {/* Stats bar */}
      {summary && (
        <div className="mb-5 grid grid-cols-4 gap-3">
          {[
            { label: 'Total', value: summary.total_tasks },
            { label: 'Completed', value: summary.completed_tasks },
            { label: 'Drift flagged', value: summary.drift_flagged_count },
            { label: 'Fields', value: Object.keys(summary.fields).length },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-center">
              <div className="text-xl font-bold text-gray-900">{value}</div>
              <div className="text-xs text-gray-400 mt-0.5">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Confidence threshold */}
      <div className="mb-5 flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-3">
        <label className="text-xs font-medium text-gray-600 whitespace-nowrap">Confidence filter</label>
        <input type="range" min={0} max={1} step={0.05} value={confidenceThreshold}
          onChange={e => setConfidenceThreshold(Number(e.target.value))} className="flex-1 h-1.5 accent-indigo-600" />
        <span className="text-xs font-mono text-gray-500 w-10 text-right">{confidenceThreshold === 0 ? 'off' : `≥${Math.round(confidenceThreshold * 100)}%`}</span>
        <p className="text-xs text-gray-400 ml-2">Exclude extractions below this confidence.</p>
      </div>

      {/* Tabs */}
      <div className="mb-5 flex gap-0 border-b border-gray-200">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === t.key ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>}

      {/* ── Results tab ─────────────────────────────────────────────────────── */}
      {tab === 'results' && (
        <ResultsTab
          summary={summary}
          respondents={respondents}
          loading={loadingSummary}
          runId={runId}
          confidenceThreshold={confidenceThreshold}
          insightsModel={insightsModel}
          onSummaryGenerated={handleSummaryGenerated}
        />
      )}

      {/* ── Transcripts tab ──────────────────────────────────────────────────── */}
      {tab === 'transcripts' && (
        <TranscriptsTab respondents={respondents} loading={loadingRespondents} schemaFields={schemaFields} />
      )}

      {/* ── Variables tab ────────────────────────────────────────────────────── */}
      {tab === 'variables' && hasInjectedVars && (
        <VariablesTab respondents={respondents!} varKeys={injectedVarKeys} fieldKeys={outputFieldKeys} schemaFields={schemaFields} />
      )}

      {/* ── Segments tab ─────────────────────────────────────────────────────── */}
      {tab === 'segments' && (
        <SegmentsTab respondents={respondents} loading={loadingRespondents} schemaFields={schemaFields} />
      )}

      {/* ── AI Report tab ────────────────────────────────────────────────────── */}
      {tab === 'report' && (
        <ReportTab runId={runId} insightsModel={insightsModel} confidenceThreshold={confidenceThreshold}
          respondentCount={respondents?.length ?? 0} />
      )}
    </div>
  )
}

// ── Results Tab ───────────────────────────────────────────────────────────────

function ResultsTab({ summary, respondents, loading, runId, confidenceThreshold, insightsModel, onSummaryGenerated }: {
  summary: RunAnalysisSummary | null
  respondents: Respondent[] | null
  loading: boolean
  runId: string
  confidenceThreshold: number
  insightsModel: string
  onSummaryGenerated: (key: string, summary: string) => void
}) {
  if (loading) return <div className="flex items-center gap-2 text-sm text-gray-400 py-12"><Spin />Computing statistics…</div>
  if (!summary) return null
  const fields = Object.values(summary.fields)

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(field => (
          <FieldCard key={field.key} field={field} runId={runId} confidenceThreshold={confidenceThreshold}
            insightsModel={insightsModel} onSummaryGenerated={onSummaryGenerated} />
        ))}
        {fields.length === 0 && (
          <div className="col-span-2 text-center py-12 text-sm text-gray-400">No output schema fields found.</div>
        )}
      </div>

      {/* Correlation heatmap for numeric fields */}
      {respondents && (
        <CorrelationHeatmap fields={fields} respondents={respondents} />
      )}
    </div>
  )
}

// ── Correlation heatmap ──────────────────────────────────────────────────────

function CorrelationHeatmap({ fields, respondents }: { fields: FieldSummary[]; respondents: Respondent[] }) {
  const [open, setOpen] = useState(false)
  const numericFields = fields.filter(f => ['scale', 'integer', 'float', 'number'].includes(f.type))
  if (numericFields.length < 2) return null

  const matrix = useMemo(() => {
    const rows: { a: string; b: string; r: number | null; p: number }[] = []
    for (let i = 0; i < numericFields.length; i++) {
      for (let j = 0; j < numericFields.length; j++) {
        const a = numericFields[i].key
        const b = numericFields[j].key
        if (i === j) { rows.push({ a, b, r: 1, p: 0 }); continue }
        const pairs: { x: number; y: number }[] = []
        for (const r of respondents) {
          const xv = parseFloat(String(r.extracted_json[a] ?? ''))
          const yv = parseFloat(String(r.extracted_json[b] ?? ''))
          if (!isNaN(xv) && !isNaN(yv)) pairs.push({ x: xv, y: yv })
        }
        const corr = pearsonCorrelation(pairs.map(p => p.x), pairs.map(p => p.y))
        rows.push({ a, b, r: corr?.r ?? null, p: corr?.p ?? 1 })
      }
    }
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, respondents])

  const colorForR = (r: number | null): string => {
    if (r === null || !isFinite(r)) return 'bg-gray-50'
    const abs = Math.abs(r)
    if (r > 0) {
      if (abs >= 0.7) return 'bg-teal-500 text-white'
      if (abs >= 0.4) return 'bg-teal-300'
      if (abs >= 0.2) return 'bg-teal-100'
      return 'bg-teal-50'
    } else {
      if (abs >= 0.7) return 'bg-rose-500 text-white'
      if (abs >= 0.4) return 'bg-rose-300'
      if (abs >= 0.2) return 'bg-rose-100'
      return 'bg-rose-50'
    }
  }

  const keyToLabel = Object.fromEntries(numericFields.map(f => [f.key, f.description || f.key]))

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="w-full px-5 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between hover:bg-gray-100 transition-colors">
        <div className="flex items-center gap-2">
          <svg className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <h3 className="text-sm font-medium text-gray-700">Correlation heatmap</h3>
          <span className="text-xs text-gray-400">{numericFields.length} numeric fields</span>
        </div>
        <span className="text-xs text-gray-400">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="p-4 overflow-x-auto">
          <table className="text-xs border-separate border-spacing-0.5">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left"></th>
                {numericFields.map(f => (
                  <th key={f.key} className="px-2 py-1 text-xs text-gray-500 font-medium text-left truncate max-w-[100px]" title={keyToLabel[f.key]}>
                    {keyToLabel[f.key]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {numericFields.map(fi => (
                <tr key={fi.key}>
                  <td className="px-2 py-1 text-xs text-gray-500 font-medium truncate max-w-[160px]" title={keyToLabel[fi.key]}>
                    {keyToLabel[fi.key]}
                  </td>
                  {numericFields.map(fj => {
                    const cell = matrix.find(m => m.a === fi.key && m.b === fj.key)
                    const r = cell?.r
                    const p = cell?.p ?? 1
                    return (
                      <td key={fj.key}
                        className={`px-2 py-1 text-center font-mono text-[11px] border border-white rounded ${colorForR(r ?? null)}`}
                        title={r !== null && r !== undefined ? `r=${r.toFixed(3)}, p=${p.toFixed(3)}` : 'n/a'}>
                        {r !== null && r !== undefined ? r.toFixed(2) : '—'}
                        {p < 0.05 && fi.key !== fj.key && <span className="ml-0.5">*</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
            <div className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 bg-rose-500 rounded-sm" />
              <span>-1</span>
              <span className="inline-block w-3 h-3 bg-rose-200 rounded-sm" />
              <span className="inline-block w-3 h-3 bg-gray-100 rounded-sm" />
              <span>0</span>
              <span className="inline-block w-3 h-3 bg-teal-200 rounded-sm" />
              <span className="inline-block w-3 h-3 bg-teal-500 rounded-sm" />
              <span>+1</span>
            </div>
            <span className="text-gray-400">* p &lt; 0.05</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Transcripts Tab ───────────────────────────────────────────────────────────

function TranscriptsTab({ respondents, loading, schemaFields }: {
  respondents: Respondent[] | null; loading: boolean; schemaFields: FieldSummary[]
}) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  if (loading) return <div className="flex items-center gap-2 text-sm text-gray-400 py-12"><Spin />Loading respondents…</div>
  if (!respondents) return null

  const filtered = respondents.filter(r => {
    if (!search) return true
    const s = search.toLowerCase()
    return (
      r.raw_transcript.toLowerCase().includes(s) ||
      Object.values(r.persona_traits).some(v => String(v).toLowerCase().includes(s)) ||
      Object.values(r.extracted_json).some(v => String(v).toLowerCase().includes(s))
    )
  })

  const traitKeys = respondents.length > 0 ? Object.keys(respondents[0].persona_traits).slice(0, 4) : []

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search transcripts, traits, or extracted values…"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
        <span className="text-xs text-gray-400">{filtered.length} of {respondents.length}</span>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        {/* Table header */}
        <div className="grid border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-xs font-medium text-gray-500 gap-3"
          style={{ gridTemplateColumns: `2rem 1fr ${traitKeys.map(() => '1fr').join(' ')} ${schemaFields.slice(0, 3).map(() => '1fr').join(' ')} 5rem` }}>
          <div>#</div>
          <div>Persona ID</div>
          {traitKeys.map(k => <div key={k} className="truncate">{k.replace(/_/g, ' ')}</div>)}
          {schemaFields.slice(0, 3).map(f => <div key={f.key} className="truncate">{f.description || f.key}</div>)}
          <div>Status</div>
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-10 text-sm text-gray-400">No results match your search.</div>
        )}

        {filtered.map((r, idx) => {
          const isOpen = expanded === r.task_id
          const completedBoth = r.pass1_status === 'completed' && r.pass2_status === 'completed'
          return (
            <div key={r.task_id} className={`border-b border-gray-100 last:border-0 ${isOpen ? 'bg-indigo-50/30' : 'hover:bg-gray-50'} transition-colors`}>
              {/* Row */}
              <button className="w-full text-left" onClick={() => setExpanded(isOpen ? null : r.task_id)}>
                <div className="grid items-center px-4 py-3 text-sm gap-3"
                  style={{ gridTemplateColumns: `2rem 1fr ${traitKeys.map(() => '1fr').join(' ')} ${schemaFields.slice(0, 3).map(() => '1fr').join(' ')} 5rem` }}>
                  <span className="text-xs text-gray-400">{idx + 1}</span>
                  <span className="font-mono text-xs text-gray-500 truncate">{r.persona_id.slice(0, 8)}…</span>
                  {traitKeys.map(k => (
                    <span key={k} className="text-xs text-gray-700 truncate">{String(r.persona_traits[k] ?? '—')}</span>
                  ))}
                  {schemaFields.slice(0, 3).map(f => (
                    <span key={f.key} className="text-xs text-gray-700 truncate">{String(r.extracted_json[f.key] ?? '—')}</span>
                  ))}
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${completedBoth ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                    {completedBoth ? 'done' : r.pass1_status}
                  </span>
                </div>
              </button>

              {/* Expanded detail */}
              {isOpen && (
                <RespondentDeepDive respondent={r} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Respondent deep-dive ──────────────────────────────────────────────────────

function RespondentDeepDive({ respondent: r }: { respondent: Respondent }) {
  const [viewMode, setViewMode] = useState<'parsed' | 'raw'>('parsed')
  const turns = useMemo(() => parseTranscript(r.raw_transcript), [r.raw_transcript])
  const canParse = turns.some(t => t.speaker === 'interviewer' || t.speaker === 'respondent')

  return (
    <div className="px-5 pb-5 pt-1 space-y-4 border-t border-indigo-100">
      {/* Traits + injected vars */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Persona Profile</p>
          <div className="space-y-1">
            {Object.entries(r.persona_traits).map(([k, v]) => (
              <div key={k} className="flex justify-between text-xs">
                <span className="text-gray-500">{k.replace(/_/g, ' ')}</span>
                <span className="text-gray-800 font-medium">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          {Object.keys(r.injected_vars).length > 0 && (
            <>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Stimulus Variables</p>
              <div className="space-y-1">
                {Object.entries(r.injected_vars).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-xs">
                    <span className="text-gray-500 font-mono">{'{' + k + '}'}</span>
                    <span className="text-teal-700 font-medium">{String(v)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {Object.keys(r.extracted_json).length > 0 && (
            <>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 mt-3">Extracted Values</p>
              <div className="space-y-1">
                {Object.entries(r.extracted_json).map(([k, v]) => {
                  const conf = r.extraction_confidence[k]
                  return (
                    <div key={k} className="flex justify-between text-xs">
                      <span className="text-gray-500">{k}</span>
                      <span className="text-gray-800 font-medium">
                        {String(v)}{conf !== undefined && <span className="text-gray-400 ml-1">({Math.round(conf * 100)}%)</span>}
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Transcript */}
      {r.raw_transcript && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Transcript</p>
            {canParse && (
              <div className="inline-flex rounded-lg border border-gray-200 bg-white text-xs">
                <button onClick={() => setViewMode('parsed')}
                  className={`px-2 py-1 rounded-l-lg ${viewMode === 'parsed' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
                  Q/A
                </button>
                <button onClick={() => setViewMode('raw')}
                  className={`px-2 py-1 rounded-r-lg ${viewMode === 'raw' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
                  Raw
                </button>
              </div>
            )}
          </div>
          {viewMode === 'parsed' && canParse ? (
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 space-y-2.5 max-h-96 overflow-y-auto">
              {turns.map((t, i) => (
                <div key={i} className={`flex gap-3 ${t.speaker === 'interviewer' ? 'flex-row' : t.speaker === 'respondent' ? 'flex-row-reverse' : ''}`}>
                  <span className={`text-[10px] uppercase font-bold mt-1 flex-shrink-0 tracking-wider ${
                    t.speaker === 'interviewer' ? 'text-indigo-600' :
                    t.speaker === 'respondent' ? 'text-teal-600' : 'text-gray-400'
                  }`}>{t.speaker === 'interviewer' ? 'Q' : t.speaker === 'respondent' ? 'A' : '·'}</span>
                  <div className={`flex-1 rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                    t.speaker === 'interviewer' ? 'bg-indigo-50 text-indigo-900' :
                    t.speaker === 'respondent' ? 'bg-white border border-gray-200 text-gray-700' :
                    'bg-gray-100 text-gray-500'
                  }`}>
                    {t.text}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-xs text-gray-700 leading-relaxed whitespace-pre-wrap max-h-80 overflow-y-auto font-mono">
              {r.raw_transcript}
            </div>
          )}
        </div>
      )}

      {r.drift_flagged && (
        <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          ⚠ Drift detected — persona may have diverged from profile during interview
        </div>
      )}
    </div>
  )
}

// ── Variables Tab ─────────────────────────────────────────────────────────────

function VariablesTab({ respondents, varKeys, fieldKeys, schemaFields }: {
  respondents: Respondent[]; varKeys: string[]; fieldKeys: string[]; schemaFields: FieldSummary[]
}) {
  const [selectedVar, setSelectedVar] = useState(varKeys[0] ?? '')
  const [selectedField, setSelectedField] = useState(fieldKeys[0] ?? '')

  if (!selectedVar || !selectedField) return <div className="text-sm text-gray-400 py-12 text-center">No variables or fields available.</div>

  const fieldMeta = schemaFields.find(f => f.key === selectedField)
  const fieldType = fieldMeta?.type ?? 'string'

  // Group respondents by selected variable value
  const groups: Record<string, Respondent[]> = {}
  for (const r of respondents) {
    const val = String(r.injected_vars[selectedVar] ?? 'N/A')
    if (!groups[val]) groups[val] = []
    groups[val].push(r)
  }
  const groupEntries = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))

  // Compute overall significance across all groups
  const isNumericField = ['scale', 'integer', 'float', 'number'].includes(fieldType)
  let overallP: number | null = null
  let overallEta: number | null = null
  let twoGroupD: number | null = null
  if (isNumericField && groupEntries.length >= 2) {
    const numericGroups = groupEntries.map(([, g]) => toNumbers(g.map(r => r.extracted_json[selectedField])))
    const anova = oneWayANOVA(numericGroups)
    if (anova) { overallP = anova.p; overallEta = Math.sqrt(anova.etaSquared) }
    if (numericGroups.length === 2 && numericGroups[0].length > 1 && numericGroups[1].length > 1) {
      const tt = welchTTest(numericGroups[0], numericGroups[1])
      if (tt) { twoGroupD = tt.d }
    }
  } else if (groupEntries.length >= 2) {
    // categorical — Cramér's V
    const xs: string[] = []; const ys: string[] = []
    for (const [val, g] of groupEntries) {
      for (const r of g) {
        const v = r.extracted_json[selectedField]
        if (v !== undefined && v !== null && v !== '') {
          xs.push(val); ys.push(String(v))
        }
      }
    }
    const v = cramersV(xs, ys)
    if (v) { overallP = v.p; overallEta = v.v }
  }

  return (
    <div>
      <div className="mb-5 flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Stimulus variable</label>
          <select value={selectedVar} onChange={e => setSelectedVar(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none bg-white">
            {varKeys.map(k => <option key={k} value={k}>{'{' + k + '}'}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Output field</label>
          <select value={selectedField} onChange={e => setSelectedField(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none bg-white">
            {schemaFields.map(f => <option key={f.key} value={f.key}>{f.description || f.key}</option>)}
          </select>
        </div>
        {overallP !== null && (
          <SigBadge
            p={overallP}
            effect={twoGroupD !== null ? twoGroupD : overallEta}
            effectLabel={twoGroupD !== null ? 'd' : (isNumericField ? 'η' : 'V')}
          />
        )}
        <span className="text-xs text-gray-400 ml-auto">{groupEntries.length} groups · {respondents.length} total</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {groupEntries.map(([val, group]) => {
          const values = group.map(r => r.extracted_json[selectedField]).filter(v => v !== undefined && v !== null)
          return (
            <div key={val} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <span className="text-xs font-medium text-gray-500 font-mono">{'{' + selectedVar + '}'} =</span>
                  <span className="ml-1 font-semibold text-teal-700">{val}</span>
                </div>
                <span className="text-xs text-gray-400">n={group.length}</span>
              </div>
              <MiniStats values={values} type={fieldType} />
            </div>
          )
        })}
      </div>

      {/* Comparison table for numeric fields */}
      {isNumericField && groupEntries.length > 1 && (
        <div className="mt-5 rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3">
            <h3 className="text-sm font-medium text-gray-700">Mean comparison — {fieldMeta?.description || selectedField}</h3>
            {overallP !== null && (
              <SigBadge
                p={overallP}
                effect={twoGroupD !== null ? twoGroupD : overallEta}
                effectLabel={twoGroupD !== null ? 'd' : 'η'}
              />
            )}
            {twoGroupD !== null && (
              <span className="text-xs text-gray-400">{cohenLabel(twoGroupD)} effect</span>
            )}
          </div>
          <div className="p-4">
            {(() => {
              const statsPerGroup = groupEntries.map(([val, group]) => {
                const nums = toNumbers(group.map(r => r.extracted_json[selectedField]))
                const stats = computeNumericStats(nums)
                return { val, mean: stats?.mean ?? null, n: nums.length }
              }).filter(g => g.mean !== null)
              const maxMean = Math.max(...statsPerGroup.map(g => g.mean!), 0.001)
              return statsPerGroup.map(g => (
                <div key={g.val} className="mb-2">
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span className="font-mono text-teal-700 font-medium">{g.val}</span>
                    <span className="text-gray-600">{g.mean} <span className="text-gray-400">(n={g.n})</span></span>
                  </div>
                  <div className="relative h-2 rounded-full bg-gray-100">
                    <div className="absolute left-0 top-0 h-2 rounded-full bg-teal-400" style={{ width: `${(g.mean! / maxMean) * 100}%` }} />
                  </div>
                </div>
              ))
            })()}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Segments Tab ──────────────────────────────────────────────────────────────

interface Filter {
  key: string
  op: '=' | '≠' | '>' | '<'
  value: string
}

function SegmentsTab({ respondents, loading, schemaFields }: {
  respondents: Respondent[] | null; loading: boolean; schemaFields: FieldSummary[]
}) {
  const [selectedTrait, setSelectedTrait] = useState('')
  const [selectedField, setSelectedField] = useState(schemaFields[0]?.key ?? '')
  const [filters, setFilters] = useState<Filter[]>([])
  const [filterKey, setFilterKey] = useState('')
  const [filterOp, setFilterOp] = useState<Filter['op']>('=')
  const [filterValue, setFilterValue] = useState('')

  if (loading) return <div className="flex items-center gap-2 text-sm text-gray-400 py-12"><Spin />Loading respondents…</div>
  if (!respondents || respondents.length === 0) return <div className="text-sm text-gray-400 py-12 text-center">No respondent data available.</div>

  const traitKeys = Array.from(new Set(respondents.flatMap(r => Object.keys(r.persona_traits))))
  const varKeys = Array.from(new Set(respondents.flatMap(r => Object.keys(r.injected_vars))))
  const allFilterKeys = [...traitKeys.map(k => `trait:${k}`), ...varKeys.map(k => `var:${k}`)]

  const getValue = (r: Respondent, key: string): unknown => {
    if (key.startsWith('trait:')) return r.persona_traits[key.slice(6)]
    if (key.startsWith('var:')) return r.injected_vars[key.slice(4)]
    return undefined
  }

  // Apply filters
  const filteredResps = respondents.filter(r => {
    return filters.every(f => {
      const v = getValue(r, f.key)
      if (v === undefined || v === null) return false
      const sv = String(v)
      if (f.op === '=') return sv === f.value
      if (f.op === '≠') return sv !== f.value
      const nv = parseFloat(sv); const nf = parseFloat(f.value)
      if (isNaN(nv) || isNaN(nf)) return false
      if (f.op === '>') return nv > nf
      if (f.op === '<') return nv < nf
      return true
    })
  })

  // Auto-select first trait
  const activeTrait = selectedTrait || traitKeys[0] || ''
  const activeField = selectedField || schemaFields[0]?.key || ''
  const fieldMeta = schemaFields.find(f => f.key === activeField)
  const fieldType = fieldMeta?.type ?? 'string'
  const isNumericField = ['scale', 'integer', 'float', 'number'].includes(fieldType)

  // Group by trait value — for numerics, bucket into 3 quantile groups
  const traitValues = filteredResps.map(r => r.persona_traits[activeTrait])
  const traitDefined = traitValues.filter(v => v !== undefined && v !== null && v !== '')
  const isNumericTrait = traitDefined.length > 0 && traitDefined.every(v => !isNaN(parseFloat(String(v))))

  const groups: Record<string, Respondent[]> = {}
  if (isNumericTrait && activeTrait) {
    const nums = toNumbers(traitValues)
    if (nums.length > 0) {
      const bucket = tertileBuckets(nums)
      for (const r of filteredResps) {
        const raw = r.persona_traits[activeTrait]
        if (raw === undefined || raw === null || raw === '') continue
        const v = parseFloat(String(raw))
        if (isNaN(v)) continue
        const label = bucket.label(v)
        if (!groups[label]) groups[label] = []
        groups[label].push(r)
      }
    }
  } else if (activeTrait) {
    for (const r of filteredResps) {
      const val = String(r.persona_traits[activeTrait] ?? 'N/A')
      if (!groups[val]) groups[val] = []
      groups[val].push(r)
    }
  }

  const groupEntries = Object.entries(groups).sort((a, b) => b[1].length - a[1].length)

  // Compute overall significance for header badge
  let headerP: number | null = null
  let headerEta: number | null = null
  let headerD: number | null = null
  if (groupEntries.length >= 2) {
    if (isNumericField) {
      const numericGroups = groupEntries.map(([, g]) => toNumbers(g.map(r => r.extracted_json[activeField])))
      const anova = oneWayANOVA(numericGroups)
      if (anova) { headerP = anova.p; headerEta = Math.sqrt(anova.etaSquared) }
      if (numericGroups.length === 2) {
        const tt = welchTTest(numericGroups[0], numericGroups[1])
        if (tt) headerD = tt.d
      }
    } else {
      const xs: string[] = []; const ys: string[] = []
      for (const [val, g] of groupEntries) {
        for (const r of g) {
          const v = r.extracted_json[activeField]
          if (v !== undefined && v !== null && v !== '') {
            xs.push(val); ys.push(String(v))
          }
        }
      }
      const v = cramersV(xs, ys)
      if (v) { headerP = v.p; headerEta = v.v }
    }
  }

  const addFilter = () => {
    if (!filterKey || !filterValue) return
    setFilters([...filters, { key: filterKey, op: filterOp, value: filterValue }])
    setFilterKey(''); setFilterValue('')
  }

  return (
    <div className="space-y-5">
      {/* Filter bar */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-600">Filters</span>
          {filters.map((f, i) => {
            const [kind, key] = f.key.split(':')
            return (
              <span key={i} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2.5 py-1 text-xs">
                <span className="text-indigo-400">{kind === 'trait' ? '👤' : '⚙️'}</span>
                <span className="font-medium text-indigo-700">{key}</span>
                <span className="text-gray-500">{f.op}</span>
                <span className="text-gray-700">{f.value}</span>
                <button onClick={() => setFilters(filters.filter((_, j) => j !== i))}
                  className="ml-1 text-indigo-400 hover:text-indigo-700">×</button>
              </span>
            )
          })}
          {filters.length === 0 && <span className="text-xs text-gray-400">No filters active — analysing all {respondents.length} respondents</span>}
        </div>
        <div className="flex items-center gap-2">
          <select value={filterKey} onChange={e => setFilterKey(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none bg-white">
            <option value="">— select trait/var —</option>
            {traitKeys.length > 0 && <optgroup label="Persona traits">
              {traitKeys.map(k => <option key={k} value={`trait:${k}`}>{k}</option>)}
            </optgroup>}
            {varKeys.length > 0 && <optgroup label="Stimulus variables">
              {varKeys.map(k => <option key={k} value={`var:${k}`}>{k}</option>)}
            </optgroup>}
          </select>
          <select value={filterOp} onChange={e => setFilterOp(e.target.value as Filter['op'])}
            className="rounded-lg border border-gray-300 px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none bg-white">
            <option value="=">=</option>
            <option value="≠">≠</option>
            <option value=">">&gt;</option>
            <option value="<">&lt;</option>
          </select>
          <input type="text" value={filterValue} onChange={e => setFilterValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addFilter() }}
            placeholder="value"
            className="flex-1 rounded-lg border border-gray-300 px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none" />
          <button onClick={addFilter} disabled={!filterKey || !filterValue}
            className="rounded-lg bg-indigo-600 text-white px-3 py-1 text-xs font-medium hover:bg-indigo-700 disabled:opacity-50">
            Add
          </button>
        </div>
        {allFilterKeys.length > 0 && filters.length > 0 && (
          <p className="text-xs text-gray-400">{filteredResps.length} of {respondents.length} respondents match filters</p>
        )}
      </div>

      {/* Key Driver Analysis */}
      <KeyDriverAnalysis respondents={filteredResps} traitKeys={traitKeys} schemaFields={schemaFields} />

      {/* Segment configuration */}
      <div className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Segment by trait</label>
          <select value={activeTrait} onChange={e => setSelectedTrait(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none bg-white">
            {traitKeys.map(k => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Output field</label>
          <select value={activeField} onChange={e => setSelectedField(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none bg-white">
            {schemaFields.map(f => <option key={f.key} value={f.key}>{f.description || f.key}</option>)}
          </select>
        </div>
        {headerP !== null && (
          <SigBadge p={headerP} effect={headerD !== null ? headerD : headerEta} effectLabel={headerD !== null ? 'd' : (isNumericField ? 'η' : 'V')} />
        )}
        <span className="text-xs text-gray-400 ml-auto">{groupEntries.length} segments</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {groupEntries.map(([val, group]) => {
          const values = group.map(r => r.extracted_json[activeField]).filter(v => v !== undefined && v !== null)
          return (
            <div key={val} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <span className="text-xs font-medium text-gray-500">{(activeTrait || '').replace(/_/g, ' ')} =</span>
                  <span className="ml-1 font-semibold text-indigo-700">{val}</span>
                </div>
                <span className="text-xs text-gray-400">n={group.length}</span>
              </div>
              <MiniStats values={values} type={fieldType} />
            </div>
          )
        })}
      </div>

      {/* Cross-table: all fields × all segments with per-field significance */}
      {groupEntries.length > 1 && schemaFields.length > 1 && (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
            <h3 className="text-sm font-medium text-gray-700">All fields by segment</h3>
            <p className="text-xs text-gray-400 mt-0.5">Rows tinted when differences are statistically significant.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-2 text-left text-gray-500 font-medium">Field</th>
                  {groupEntries.map(([val, group]) => (
                    <th key={val} className="px-4 py-2 text-left text-gray-500 font-medium">
                      {val} <span className="text-gray-400 font-normal">(n={group.length})</span>
                    </th>
                  ))}
                  <th className="px-4 py-2 text-left text-gray-500 font-medium">Significance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {schemaFields.map(f => {
                  const fieldIsNumeric = ['scale', 'integer', 'float', 'number'].includes(f.type)
                  let rowP: number | null = null
                  let rowEffect: number | null = null
                  if (fieldIsNumeric) {
                    const grps = groupEntries.map(([, g]) => toNumbers(g.map(r => r.extracted_json[f.key])))
                    const anova = oneWayANOVA(grps)
                    if (anova) { rowP = anova.p; rowEffect = Math.sqrt(anova.etaSquared) }
                  } else if (f.type !== 'open_ended' && f.type !== 'text' && f.type !== 'string') {
                    const xs: string[] = []; const ys: string[] = []
                    for (const [val, g] of groupEntries) {
                      for (const r of g) {
                        const v = r.extracted_json[f.key]
                        if (v !== undefined && v !== null && v !== '') {
                          xs.push(val); ys.push(String(v))
                        }
                      }
                    }
                    const v = cramersV(xs, ys)
                    if (v) { rowP = v.p; rowEffect = v.v }
                  }
                  const sig = rowP !== null && rowP < 0.05
                  return (
                    <tr key={f.key} className={`${sig ? 'bg-emerald-50/40 hover:bg-emerald-50' : 'hover:bg-gray-50'}`}>
                      <td className="px-4 py-2.5 text-gray-700 font-medium">{f.description || f.key}</td>
                      {groupEntries.map(([val, group]) => {
                        const vals = group.map(r => r.extracted_json[f.key]).filter(v => v !== undefined && v !== null)
                        return (
                          <td key={val} className="px-4 py-2.5">
                            <MiniStats values={vals} type={f.type} />
                          </td>
                        )
                      })}
                      <td className="px-4 py-2.5">
                        {rowP !== null ? (
                          <SigBadge p={rowP} effect={rowEffect} effectLabel={fieldIsNumeric ? 'η' : 'V'} />
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Key Driver Analysis ───────────────────────────────────────────────────────

function KeyDriverAnalysis({ respondents, traitKeys, schemaFields }: {
  respondents: Respondent[]; traitKeys: string[]; schemaFields: FieldSummary[]
}) {
  const [selectedField, setSelectedField] = useState(schemaFields[0]?.key ?? '')
  const fieldMeta = schemaFields.find(f => f.key === selectedField)
  const fieldType = fieldMeta?.type ?? 'string'

  const drivers = useMemo(
    () => computeDrivers(respondents, traitKeys, selectedField, fieldType),
    [respondents, traitKeys, selectedField, fieldType]
  )

  if (drivers.length === 0) return null

  const topN = drivers.slice(0, 8)
  const maxStrength = Math.max(...topN.map(d => d.strength), 0.01)

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3">
        <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
        </svg>
        <h3 className="text-sm font-medium text-gray-700">Key Drivers</h3>
        <p className="text-xs text-gray-400">Which persona traits most influence —</p>
        <select value={selectedField} onChange={e => setSelectedField(e.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none bg-white">
          {schemaFields.map(f => <option key={f.key} value={f.key}>{f.description || f.key}</option>)}
        </select>
      </div>
      <div className="p-4 space-y-2">
        {topN.map(d => {
          const pctWidth = (d.strength / maxStrength) * 100
          const sig = d.p < 0.05
          const barColor = d.direction > 0 ? 'bg-teal-400' : d.direction < 0 ? 'bg-rose-400' : 'bg-indigo-400'
          return (
            <div key={d.traitKey} className="flex items-center gap-3">
              <div className="w-40 text-xs text-gray-700 truncate text-right" title={d.traitKey}>
                {d.traitKey.replace(/_/g, ' ')}
              </div>
              <div className="flex-1 relative h-5 rounded-md bg-gray-50 overflow-hidden">
                <div className={`h-full rounded-md transition-all ${barColor} ${sig ? 'opacity-100' : 'opacity-40'}`}
                  style={{ width: `${pctWidth}%` }} />
                <span className="absolute inset-0 flex items-center px-2 text-[10px] text-gray-700 font-mono">
                  {d.valueLabel}
                </span>
              </div>
              <div className="w-24 text-right">
                <SigBadge p={d.p} />
              </div>
            </div>
          )
        })}
        <p className="text-xs text-gray-400 pt-2">
          Numeric traits use Pearson r (teal positive, rose negative). Categorical traits use ANOVA η or Cramér&apos;s V (neutral colour).
        </p>
      </div>
    </div>
  )
}

// ── AI Report Tab ─────────────────────────────────────────────────────────────

const ANALYSIS_TYPES: { value: AnalysisType; label: string; description: string }[] = [
  { value: 'executive_summary', label: 'Executive Summary', description: '3–5 key findings and their implications' },
  { value: 'segment_analysis', label: 'Segment Analysis', description: 'How different respondent groups compare' },
  { value: 'opportunity_map', label: 'Opportunity Map', description: 'Unmet needs, adoption drivers, pull factors' },
  { value: 'objection_analysis', label: 'Objection Analysis', description: 'Barriers, concerns, and adoption blockers' },
  { value: 'custom', label: 'Custom', description: 'Write your own analysis prompt' },
]

const CONTEXT_MODES: { value: ContextMode; label: string; description: string }[] = [
  { value: 'quick', label: 'Quick', description: 'Aggregate stats only — fast and cheap' },
  { value: 'standard', label: 'Standard', description: 'Stats + persona profiles + sample transcripts' },
  { value: 'full', label: 'Full', description: 'All transcripts + profiles — most thorough' },
]

function ReportTab({ runId, insightsModel, confidenceThreshold, respondentCount }: {
  runId: string; insightsModel: string; confidenceThreshold: number; respondentCount: number
}) {
  const [analysisType, setAnalysisType] = useState<AnalysisType>('executive_summary')
  const [contextMode, setContextMode] = useState<ContextMode>('standard')
  const [sampleSize, setSampleSize] = useState(10)
  const [customPrompt, setCustomPrompt] = useState('')
  const [result, setResult] = useState<DeepDiveResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)

  const maxSample = Math.max(respondentCount, 1)

  const handleGenerate = async () => {
    setLoading(true); setError(null)
    try {
      const body: DeepDiveRequest = {
        confidence_threshold: confidenceThreshold,
        analysis_type: analysisType,
        context_mode: contextMode,
        sample_size: contextMode === 'standard' ? sampleSize : respondentCount,
        custom_prompt: customPrompt,
      }
      setResult(await api.generateDeepDive(runId, body))
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Generation failed') }
    finally { setLoading(false) }
  }

  return (
    <div className="space-y-5">
      {/* Configuration panel */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-5">
        {/* Analysis type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Analysis type</label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {ANALYSIS_TYPES.map(t => (
              <button key={t.value} onClick={() => setAnalysisType(t.value)}
                className={`rounded-lg border p-3 text-left transition-colors ${analysisType === t.value ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <div className="text-xs font-semibold text-gray-800">{t.label}</div>
                <div className="text-xs text-gray-400 mt-0.5 leading-tight">{t.description}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Custom prompt */}
        {analysisType === 'custom' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Your analysis prompt</label>
            <textarea value={customPrompt} onChange={e => setCustomPrompt(e.target.value)} rows={3}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="e.g. Identify the price sensitivity threshold across different segments and explain what drives the differences…" />
          </div>
        )}

        {/* Context mode */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Context to provide</label>
          <div className="grid grid-cols-3 gap-2">
            {CONTEXT_MODES.map(m => (
              <button key={m.value} onClick={() => setContextMode(m.value)}
                className={`rounded-lg border p-3 text-left transition-colors ${contextMode === m.value ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <div className="text-xs font-semibold text-gray-800">{m.label}</div>
                <div className="text-xs text-gray-400 mt-0.5 leading-tight">{m.description}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Sample size (standard mode only) */}
        {contextMode === 'standard' && (
          <div className="flex items-center gap-4">
            <label className="text-xs font-medium text-gray-600 whitespace-nowrap">Transcripts to sample</label>
            <input type="range" min={1} max={maxSample} step={1} value={Math.min(sampleSize, maxSample)}
              onChange={e => setSampleSize(Number(e.target.value))} className="flex-1 h-1.5 accent-indigo-600" />
            <span className="text-xs font-mono text-gray-700 w-16 text-right">{Math.min(sampleSize, maxSample)} / {maxSample}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1">
          <button onClick={handleGenerate} disabled={loading || (analysisType === 'custom' && !customPrompt.trim())}
            className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {loading ? <Spin size={4} /> : null}
            {result ? 'Regenerate' : 'Generate Report'}
          </button>
          <span className="text-xs font-mono text-gray-400 bg-gray-50 border border-gray-200 rounded px-2 py-1">{insightsModel}</span>
          <button onClick={() => setPromptOpen(false)} className="hidden" />
        </div>

        {error && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center gap-3 py-16 text-sm text-gray-400">
          <Spin size={6} />
          Generating analysis… this may take 20–40 seconds.
        </div>
      )}

      {/* Result */}
      {result && !loading && (
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
            <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
              {ANALYSIS_TYPES.find(t => t.value === result.analysis_type)?.label ?? 'Analysis'}
            </span>
            <span className="rounded-full bg-gray-50 px-3 py-1 text-xs text-gray-500">
              {CONTEXT_MODES.find(m => m.value === result.context_mode)?.label ?? 'Quick'} context
            </span>
            <span className="ml-auto text-xs text-gray-400">
              {result.model} · {(result.tokens_in + result.tokens_out).toLocaleString()} tokens · {fmtCost(result.cost_usd)}
            </span>
          </div>
          <SimpleMarkdown text={result.analysis} />
          <div className="mt-5 pt-4 border-t border-gray-100 text-xs text-gray-400">
            Generated {new Date(result.generated_at).toLocaleString()}
          </div>
        </div>
      )}

      {!result && !loading && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 py-16 text-center">
          <p className="text-sm font-medium text-gray-500">No report yet</p>
          <p className="text-xs text-gray-400 mt-1">Configure your analysis above and click Generate.</p>
        </div>
      )}

      <PromptEditorModal open={promptOpen} promptName="deep_dive" title="Edit: Deep Dive Prompt" onClose={() => setPromptOpen(false)} />
    </div>
  )
}
