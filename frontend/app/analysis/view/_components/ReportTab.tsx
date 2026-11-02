'use client'
import { useState } from 'react'
import { api, DeepDiveResult, DeepDiveRequest, AnalysisType, ContextMode } from '@/lib/api'
import { fmtCost } from '@/lib/utils'
import PromptEditorModal from '@/components/PromptEditorModal'
import { SimpleMarkdown, Spin } from './shared'

// ── AI Report Tab ─────────────────────────────────────────────────────────────

export const ANALYSIS_TYPES: { value: AnalysisType; label: string; description: string }[] = [
  { value: 'executive_summary', label: 'Executive Summary', description: '3–5 key findings and their implications' },
  { value: 'segment_analysis', label: 'Segment Analysis', description: 'How different respondent groups compare' },
  { value: 'opportunity_map', label: 'Opportunity Map', description: 'Unmet needs, adoption drivers, pull factors' },
  { value: 'objection_analysis', label: 'Objection Analysis', description: 'Barriers, concerns, and adoption blockers' },
  { value: 'custom', label: 'Custom', description: 'Write your own analysis prompt' },
]

export const CONTEXT_MODES: { value: ContextMode; label: string; description: string }[] = [
  { value: 'quick', label: 'Quick', description: 'Aggregate stats only — fast and cheap' },
  { value: 'standard', label: 'Standard', description: 'Stats + persona profiles + sample transcripts' },
  { value: 'full', label: 'Full', description: 'All transcripts + profiles — most thorough' },
]

export function ReportTab({ runId, insightsModel, confidenceThreshold, respondentCount }: {
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
      <div className="glass rounded-[14px] p-5 space-y-5">
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
        <div className="glass rounded-[14px] p-6">
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
