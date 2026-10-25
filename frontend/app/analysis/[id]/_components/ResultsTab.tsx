'use client'
import { useMemo, useState } from 'react'
import { RunAnalysisSummary, FieldSummary, Respondent } from '@/lib/api'
import { pearsonCorrelation } from '@/lib/stats'
import { Spin } from './shared'
import { FieldCard } from './FieldCards'

// ── Results Tab ───────────────────────────────────────────────────────────────

export function ResultsTab({ summary, respondents, loading, runId, confidenceThreshold, insightsModel, onSummaryGenerated }: {
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

export function CorrelationHeatmap({ fields, respondents }: { fields: FieldSummary[]; respondents: Respondent[] }) {
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
