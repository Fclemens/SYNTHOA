'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api, RunAnalysisSummary, FieldSummary, Respondent } from '@/lib/api'
import { fmtCost } from '@/lib/utils'
import { ResultsTab } from './_components/ResultsTab'
import { TranscriptsTab } from './_components/TranscriptsTab'
import { VariablesTab } from './_components/VariablesTab'
import { SegmentsTab } from './_components/SegmentsTab'
import { ReportTab } from './_components/ReportTab'

type Tab = 'results' | 'transcripts' | 'variables' | 'segments' | 'report'

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
