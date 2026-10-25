'use client'
import { useMemo, useState } from 'react'
import { api, FieldSummary, FieldSummaryScale, FieldSummaryChoice, FieldSummaryBoolean, FieldSummaryText, TextAnalyticsResult } from '@/lib/api'
import PromptEditorModal from '@/components/PromptEditorModal'
import { Spin } from './shared'

// ── Field visualizations ──────────────────────────────────────────────────────

export function ScaleCard({ field }: { field: FieldSummaryScale }) {
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

export function ChoiceCard({ field }: { field: FieldSummaryChoice }) {
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

export function BooleanCard({ field }: { field: FieldSummaryBoolean }) {
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

export function sentimentColor(s: string): string {
  if (s === 'positive') return 'bg-emerald-400'
  if (s === 'negative') return 'bg-rose-400'
  return 'bg-gray-300'
}

export function TextCard({ field, runId, confidenceThreshold }: {
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

export function FieldCard({ field, runId, confidenceThreshold, insightsModel, onSummaryGenerated }: {
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
