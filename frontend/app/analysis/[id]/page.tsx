'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api, SimulationRun, RunAnalysisSummary, FieldSummary, Respondent } from '@/lib/api'
import { fmtCost, fmtDateTime, runDetails, runLabel } from '@/lib/utils'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { Button } from '@/components/ui/Button'
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
  const [runInfo, setRunInfo] = useState<SimulationRun | null>(null)
  const [insightsModel, setInsightsModel] = useState<string>('…')

  const fetchSummary = useCallback(async (threshold: number) => {
    setLoadingSummary(true); setError(null)
    try {
      const [s, run] = await Promise.all([api.getRunSummary(runId, threshold), api.getRun(runId)])
      setSummary(s)
      setRunInfo(run)
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
    ...(hasInjectedVars ? [{ key: 'variables' as Tab, label: 'A/B variables' }] : []),
    { key: 'segments', label: 'Segments' },
    { key: 'report', label: 'AI Report' },
  ]

  return (
    <div>
      <Breadcrumbs items={[
        { label: 'Analysis', href: '/analysis' },
        ...(runInfo ? [{ label: runInfo.experiment_name ?? 'Experiment', href: `/experiments/${runInfo.experiment_id}` }] : []),
        { label: runInfo ? runLabel(runInfo) : 'Run' },
      ]} />
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">
            {runInfo ? <>{runInfo.experiment_name} <span className="text-gray-500">· {runLabel(runInfo)}</span></> : 'Results'}
          </h1>
          {runInfo && (
            <p className="mt-1 text-sm text-gray-500">
              {runDetails(runInfo)} · {fmtCost(runInfo.total_cost_usd)} · {fmtDateTime(runInfo.created_at)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href={`/runs/${runId}`}><Button size="sm" variant="ghost">Run details</Button></Link>
          <a href={api.exportAnalysisPdf(runId)} target="_blank" rel="noreferrer"><Button size="sm" variant="secondary">Export PDF</Button></a>
        </div>
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
            <div key={label} className="rounded-[10px] border border-gray-100 bg-white/[0.025] px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.06em] text-gray-500">{label}</div>
              <div className="mt-0.5 font-mono text-xl font-medium text-gray-900">{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Confidence threshold */}
      <div className="mb-5 flex items-center gap-4 glass rounded-[14px] px-5 py-3">
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
