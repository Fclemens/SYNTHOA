'use client'

import { useEffect, useState, useCallback } from 'react'
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
  AppSettings,
} from '@/lib/api'
import PromptEditorModal from '@/components/PromptEditorModal'

type Tab = 'results' | 'deepdive'

// ── Small sub-components ────────────────────────────────────────────────────

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
      {/* Mean bar */}
      <div className="relative h-2 rounded-full bg-gray-100">
        <div
          className="absolute left-0 top-0 h-2 rounded-full bg-indigo-400"
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* Histogram */}
      {field.histogram && field.histogram.length > 0 && (
        <div className="flex items-end gap-0.5 h-12">
          {field.histogram.map((b, i) => {
            const maxCount = Math.max(...field.histogram.map(x => x.count), 1)
            const h = Math.max(4, Math.round((b.count / maxCount) * 48))
            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                <div
                  className="w-full rounded-t bg-indigo-200 group-hover:bg-indigo-400 transition-colors"
                  style={{ height: `${h}px` }}
                  title={`${b.label}: ${b.count}`}
                />
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
            <div
              className="absolute left-0 top-0 h-1.5 rounded-full bg-indigo-400"
              style={{ width: `${(v.pct / maxPct) * 100}%` }}
            />
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

function TextCard({ field }: { field: FieldSummaryText }) {
  const [expanded, setExpanded] = useState(false)
  const answers = field.answers ?? []
  const showCount = expanded ? answers.length : 5
  return (
    <div className="space-y-2">
      {answers.length > 0 && (
        <div>
          <p className="text-xs text-gray-400 mb-1.5">Sample responses</p>
          <div className="space-y-1.5">
            {answers.slice(0, showCount).map((a, i) => (
              <div key={i} className="rounded bg-gray-50 px-3 py-2 text-xs text-gray-600 leading-relaxed">{a}</div>
            ))}
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

// ── Field card wrapper ───────────────────────────────────────────────────────

function FieldCard({
  field,
  runId,
  confidenceThreshold,
  insightsModel,
  onSummaryGenerated,
}: {
  field: FieldSummary
  runId: string
  confidenceThreshold: number
  insightsModel: string
  onSummaryGenerated: (key: string, summary: string) => void
}) {
  const ftype = field.type
  const label = field.description || field.key
  const isText = ftype === 'open_ended' || ftype === 'text' || ftype === 'string'
  const promptName = isText ? 'summarize_open_ended' : 'summarize_field_stats'
  const promptTitle = isText ? 'Edit: Open-ended Summary Prompt' : 'Edit: Stats Summary Prompt'

  const [summarizing, setSummarizing] = useState(false)
  const [sumError, setSumError] = useState<string | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)

  const handleSummarize = async () => {
    setSummarizing(true)
    setSumError(null)
    try {
      const res = await api.summarizeField(runId, field.key, confidenceThreshold)
      onSummaryGenerated(field.key, res.llm_summary)
    } catch (e: any) {
      setSumError(e.message)
    } finally {
      setSummarizing(false)
    }
  }

  const llmSummary = (field as any).llm_summary as string | null

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{label}</h3>
          <p className="text-xs text-gray-400 font-mono">{field.key}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-gray-400">{field.n} resp.</span>
          {field.missing > 0 && (
            <span className="text-xs text-amber-500">{field.missing} missing</span>
          )}
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 font-mono">{ftype}</span>
        </div>
      </div>

      {/* Stats visualization */}
      <div className="mt-4">
        {(ftype === 'scale' || ftype === 'number' || ftype === 'integer' || ftype === 'float') && (
          <ScaleCard field={field as FieldSummaryScale} />
        )}
        {(ftype === 'multiple_choice' || (!['scale','number','integer','float','boolean','open_ended','text','string'].includes(ftype))) && (
          <ChoiceCard field={field as FieldSummaryChoice} />
        )}
        {ftype === 'boolean' && (
          <BooleanCard field={field as FieldSummaryBoolean} />
        )}
        {isText && (
          <TextCard field={field as FieldSummaryText} />
        )}
      </div>

      {/* AI summary (shown on all field types) */}
      <div className="mt-4 pt-3 border-t border-gray-100 space-y-2">
        {llmSummary && (
          <div className="rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <svg className="h-3 w-3 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.347a3 3 0 01-4.243 0l-.347-.347a5 5 0 010-7.072z" />
              </svg>
              <span className="text-xs font-medium text-indigo-600">AI Summary</span>
            </div>
            <p className="text-xs text-gray-700 leading-relaxed">{llmSummary}</p>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleSummarize}
            disabled={summarizing}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            title={`Summarise "${label}" using ${insightsModel}`}
          >
            {summarizing ? (
              <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
            ) : (
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            )}
            {llmSummary ? 'Re-generate' : 'Generate AI summary'}
          </button>
          <button
            onClick={() => setPromptOpen(true)}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title="Edit prompt"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Edit prompt
          </button>
          {sumError && <span className="text-xs text-red-500">{sumError}</span>}
          <span className="text-xs text-gray-300 font-mono ml-auto">{insightsModel}</span>
        </div>
      </div>

      <PromptEditorModal
        open={promptOpen}
        promptName={promptName}
        title={promptTitle}
        onClose={() => setPromptOpen(false)}
      />
    </div>
  )
}

// ── Markdown renderer (simple) ───────────────────────────────────────────────

function SimpleMarkdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none text-gray-700">
      {text.split('\n').map((line, i) => {
        if (line.startsWith('## ')) return <h2 key={i} className="text-base font-bold text-gray-900 mt-5 mb-2">{line.slice(3)}</h2>
        if (line.startsWith('# ')) return <h1 key={i} className="text-lg font-bold text-gray-900 mt-4 mb-2">{line.slice(2)}</h1>
        if (line.startsWith('- ') || line.startsWith('• ')) return (
          <div key={i} className="flex gap-2 mb-1">
            <span className="text-gray-400 flex-shrink-0 mt-0.5">•</span>
            <span>{line.slice(2)}</span>
          </div>
        )
        if (line.trim() === '') return <div key={i} className="h-3" />
        return <p key={i} className="mb-1.5 leading-relaxed">{line}</p>
      })}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function AnalysisDetailPage() {
  const params = useParams()
  const runId = params.id as string

  const [tab, setTab] = useState<Tab>('results')
  const [summary, setSummary] = useState<RunAnalysisSummary | null>(null)
  const [deepDive, setDeepDive] = useState<DeepDiveResult | null>(null)
  const [loadingSummary, setLoadingSummary] = useState(true)
  const [loadingDeepDive, setLoadingDeepDive] = useState(false)
  const [confidenceThreshold, setConfidenceThreshold] = useState(0)
  const [promptOpen, setPromptOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runInfo, setRunInfo] = useState<{ created_at: string; model_pass1: string; total_cost_usd: number } | null>(null)
  const [insightsModel, setInsightsModel] = useState<string>('…')

  const fetchSummary = useCallback(async (threshold: number) => {
    setLoadingSummary(true)
    setError(null)
    try {
      const [s, run] = await Promise.all([
        api.getRunSummary(runId, threshold),
        api.getRun(runId),
      ])
      setSummary(s)
      setRunInfo({ created_at: run.created_at, model_pass1: run.model_pass1, total_cost_usd: run.total_cost_usd })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingSummary(false)
    }
  }, [runId])

  // Load insights model from settings once
  useEffect(() => {
    api.getSettings().then(s => setInsightsModel(s.effective_insights_model)).catch(() => {})
  }, [])

  useEffect(() => { fetchSummary(confidenceThreshold) }, [fetchSummary, confidenceThreshold])

  const handleSummaryGenerated = (key: string, text: string) => {
    setSummary(prev => {
      if (!prev) return prev
      const fields = { ...prev.fields }
      fields[key] = { ...fields[key], llm_summary: text } as any
      return { ...prev, fields }
    })
  }

  const handleGenerateDeepDive = async () => {
    setLoadingDeepDive(true)
    setError(null)
    try {
      const result = await api.generateDeepDive(runId, confidenceThreshold)
      setDeepDive(result)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingDeepDive(false)
    }
  }

  const handleThresholdChange = (v: number) => {
    setConfidenceThreshold(v)
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/analysis" className="text-sm text-gray-400 hover:text-gray-600 transition-colors">
              ← Analysis
            </Link>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Run {runId.slice(0, 8)}</h1>
          {runInfo && (
            <p className="text-xs text-gray-400 mt-0.5">
              {new Date(runInfo.created_at).toLocaleString()} · {runInfo.model_pass1} · ${runInfo.total_cost_usd.toFixed(3)}
            </p>
          )}
        </div>
        <a
          href={api.exportAnalysisPdf(runId)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Export PDF
        </a>
      </div>

      {/* Stats bar */}
      {summary && (
        <div className="mb-6 grid grid-cols-4 gap-3">
          {[
            { label: 'Total tasks', value: summary.total_tasks },
            { label: 'Completed', value: summary.completed_tasks },
            { label: 'Drift flagged', value: summary.drift_flagged_count },
            { label: 'Fields analyzed', value: Object.keys(summary.fields).length },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-center">
              <div className="text-xl font-bold text-gray-900">{value}</div>
              <div className="text-xs text-gray-400 mt-0.5">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Confidence threshold */}
      <div className="mb-6 flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-3">
        <label className="text-xs font-medium text-gray-600 whitespace-nowrap">
          Confidence filter
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={confidenceThreshold}
          onChange={e => handleThresholdChange(Number(e.target.value))}
          className="flex-1 h-1.5 accent-indigo-600"
        />
        <span className="text-xs font-mono text-gray-500 w-10 text-right">
          {confidenceThreshold === 0 ? 'off' : `≥${Math.round(confidenceThreshold * 100)}%`}
        </span>
        <p className="text-xs text-gray-400 ml-2">Exclude extractions below this confidence.</p>
      </div>

      {/* Tabs */}
      <div className="mb-5 flex gap-0 border-b border-gray-200">
        {(['results', 'deepdive'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'results' ? 'Results' : 'Deep Dive'}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Results tab */}
      {tab === 'results' && (
        loadingSummary ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-12">
            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            Computing statistics…
          </div>
        ) : summary ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {Object.values(summary.fields).map(field => (
              <FieldCard
                key={field.key}
                field={field}
                runId={runId}
                confidenceThreshold={confidenceThreshold}
                insightsModel={insightsModel}
                onSummaryGenerated={handleSummaryGenerated}
              />
            ))}
            {Object.keys(summary.fields).length === 0 && (
              <div className="col-span-2 text-center py-12 text-sm text-gray-400">
                No output schema fields found in this run's locked config.
              </div>
            )}
          </div>
        ) : null
      )}

      {/* Deep Dive tab */}
      {tab === 'deepdive' && (
        <div>
          <div className="flex items-center gap-2 mb-5 flex-wrap">
            <button
              onClick={handleGenerateDeepDive}
              disabled={loadingDeepDive}
              className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              title={`Generate full analysis report using ${insightsModel}`}
            >
              {loadingDeepDive ? (
                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.347a3 3 0 01-4.243 0l-.347-.347a5 5 0 010-7.072z" />
                </svg>
              )}
              {deepDive ? 'Re-generate analysis' : 'Generate AI analysis'}
            </button>
            <span className="text-xs font-mono text-gray-400 bg-gray-50 border border-gray-200 rounded px-2 py-1" title="Insights model (change in Settings)">
              {insightsModel}
            </span>
            <button
              onClick={() => setPromptOpen(true)}
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
              title="Edit analysis prompt"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit prompt
            </button>
          </div>

          {loadingDeepDive && (
            <div className="flex flex-col items-center gap-3 py-16 text-sm text-gray-400">
              <svg className="h-6 w-6 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Generating analysis… this may take 15–30 seconds.
            </div>
          )}

          {deepDive && !loadingDeepDive && (
            <div className="rounded-xl border border-gray-200 bg-white p-6">
              <SimpleMarkdown text={deepDive.analysis} />
              <div className="mt-6 pt-4 border-t border-gray-100 flex items-center gap-4 text-xs text-gray-400">
                <span>{deepDive.model}</span>
                <span>·</span>
                <span>{deepDive.tokens_in + deepDive.tokens_out} tokens</span>
                <span>·</span>
                <span>${deepDive.cost_usd.toFixed(4)}</span>
                <span>·</span>
                <span>Generated {new Date(deepDive.generated_at).toLocaleString()}</span>
              </div>
            </div>
          )}

          {!deepDive && !loadingDeepDive && (
            <div className="rounded-xl border-2 border-dashed border-gray-200 py-16 text-center">
              <svg className="mx-auto h-10 w-10 text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.347a3 3 0 01-4.243 0l-.347-.347a5 5 0 010-7.072z" />
              </svg>
              <p className="text-sm font-medium text-gray-500">No analysis yet</p>
              <p className="text-xs text-gray-400 mt-1">Click "Generate AI analysis" to produce an executive insight report.</p>
            </div>
          )}
        </div>
      )}

      <PromptEditorModal
        open={promptOpen}
        promptName="deep_dive"
        title="Edit: Deep Dive Analysis Prompt"
        onClose={() => setPromptOpen(false)}
      />
    </div>
  )
}
