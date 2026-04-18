'use client'

import { useEffect, useState, Suspense, useMemo } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  api,
  RunAnalysisSummary,
  FieldSummary,
  FieldSummaryScale,
  FieldSummaryChoice,
  FieldSummaryBoolean,
  SimulationRun,
  Experiment,
} from '@/lib/api'
import { fmtCost } from '@/lib/utils'
import { welchTTest, cramersV, toNumbers, pBadge, cohenLabel } from '@/lib/stats'

function Spin({ size = 4 }: { size?: number }) {
  return (
    <svg className={`h-${size} w-${size} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  )
}

// ── Delta indicator ──────────────────────────────────────────────────────────

function Delta({ a, b, unit = '' }: { a: number | null; b: number | null; unit?: string }) {
  if (a === null || b === null || !isFinite(a) || !isFinite(b)) return <span className="text-xs text-gray-300">—</span>
  const diff = b - a
  const absDiff = Math.abs(diff)
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
  const color = diff > 0 ? 'text-teal-600' : diff < 0 ? 'text-rose-600' : 'text-gray-400'
  return (
    <span className={`text-xs font-mono ${color}`}>
      {sign}{absDiff.toFixed(2)}{unit}
    </span>
  )
}

// ── Main compare content ──────────────────────────────────────────────────────

function CompareContent() {
  const searchParams = useSearchParams()
  const aId = searchParams.get('a') ?? ''
  const bId = searchParams.get('b') ?? ''

  const [sumA, setSumA] = useState<RunAnalysisSummary | null>(null)
  const [sumB, setSumB] = useState<RunAnalysisSummary | null>(null)
  const [runA, setRunA] = useState<SimulationRun | null>(null)
  const [runB, setRunB] = useState<SimulationRun | null>(null)
  const [respondentsA, setRespondentsA] = useState<unknown[] | null>(null)
  const [respondentsB, setRespondentsB] = useState<unknown[] | null>(null)
  const [experiment, setExperiment] = useState<Experiment | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!aId || !bId) { setError('Two run IDs required (use ?a=ID1&b=ID2).'); setLoading(false); return }
    setLoading(true)
    Promise.all([
      api.getRunSummary(aId, 0),
      api.getRunSummary(bId, 0),
      api.getRun(aId),
      api.getRun(bId),
      api.getRespondents(aId).catch(() => []),
      api.getRespondents(bId).catch(() => []),
    ])
      .then(([sa, sb, ra, rb, resA, resB]) => {
        setSumA(sa); setSumB(sb); setRunA(ra); setRunB(rb)
        setRespondentsA(resA); setRespondentsB(resB)
        if (ra.experiment_id) {
          api.getExperiment(ra.experiment_id).then(setExperiment).catch(() => {})
        }
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [aId, bId])

  // Compute per-field comparison stats
  const fieldComparisons = useMemo(() => {
    if (!sumA || !sumB) return []
    const allKeys = Array.from(new Set([...Object.keys(sumA.fields), ...Object.keys(sumB.fields)]))
    return allKeys.map(key => {
      const fA: FieldSummary | undefined = sumA.fields[key]
      const fB: FieldSummary | undefined = sumB.fields[key]
      const ftype = (fA?.type ?? fB?.type ?? 'string').toLowerCase()
      const description = fA?.description || fB?.description || key
      return { key, ftype, description, fA, fB }
    })
  }, [sumA, sumB])

  if (loading) return <div className="flex items-center gap-2 text-sm text-gray-400 py-12"><Spin />Loading comparison…</div>
  if (error) return <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
  if (!sumA || !sumB || !runA || !runB) return null

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link href="/analysis" className="text-sm text-gray-400 hover:text-gray-600 transition-colors">← Analysis</Link>
        <h1 className="text-xl font-bold text-gray-900 mt-1">Compare Runs</h1>
        {experiment && <p className="text-xs text-gray-400 mt-0.5">Experiment: {experiment.name}</p>}
      </div>

      {/* Run headers */}
      <div className="mb-5 grid grid-cols-2 gap-3">
        {[{ label: 'Run A', run: runA, sum: sumA, color: 'indigo' }, { label: 'Run B', run: runB, sum: sumB, color: 'teal' }].map(({ label, run, sum, color }) => (
          <div key={run.id} className={`rounded-xl border p-4 ${color === 'indigo' ? 'border-indigo-200 bg-indigo-50/40' : 'border-teal-200 bg-teal-50/40'}`}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color === 'indigo' ? 'bg-indigo-100 text-indigo-700' : 'bg-teal-100 text-teal-700'}`}>
                {label}
              </span>
              <span className="text-xs text-gray-500 font-mono">{run.id.slice(0, 8)}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div><span className="text-gray-400">Created:</span> <span className="text-gray-700">{new Date(run.created_at).toLocaleDateString()}</span></div>
              <div><span className="text-gray-400">Model:</span> <span className="text-gray-700 font-mono">{run.model_pass1}</span></div>
              <div><span className="text-gray-400">Cost:</span> <span className="text-gray-700">{fmtCost(run.total_cost_usd)}</span></div>
              <div><span className="text-gray-400">Respondents:</span> <span className="text-gray-700">{sum.completed_tasks}/{sum.total_tasks}</span></div>
              <div><span className="text-gray-400">Drift:</span> <span className="text-gray-700">{sum.drift_flagged_count}</span></div>
              <div><span className="text-gray-400">Fields:</span> <span className="text-gray-700">{Object.keys(sum.fields).length}</span></div>
            </div>
          </div>
        ))}
      </div>

      {/* Field-by-field comparison */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3">
          <h3 className="text-sm font-medium text-gray-700">Field-by-field comparison</h3>
          <p className="text-xs text-gray-400">Rows highlighted when differences between runs are significant.</p>
        </div>
        <div className="divide-y divide-gray-100">
          {fieldComparisons.map(({ key, ftype, description, fA, fB }) => (
            <FieldCompareRow
              key={key} fieldKey={key} ftype={ftype} description={description}
              fA={fA} fB={fB}
              respA={respondentsA ?? []} respB={respondentsB ?? []}
            />
          ))}
          {fieldComparisons.length === 0 && (
            <div className="px-5 py-8 text-sm text-gray-400 text-center">No fields to compare.</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Per-field compare row ────────────────────────────────────────────────────

function FieldCompareRow({ fieldKey, ftype, description, fA, fB, respA, respB }: {
  fieldKey: string
  ftype: string
  description: string
  fA: FieldSummary | undefined
  fB: FieldSummary | undefined
  respA: unknown[]
  respB: unknown[]
}) {
  const isNumeric = ['scale', 'integer', 'float', 'number'].includes(ftype)
  const isBool = ftype === 'boolean'
  const isText = ['open_ended', 'text', 'string'].includes(ftype)

  // Compute significance for numeric / categorical
  let p: number | null = null
  let d: number | null = null
  let v: number | null = null

  if (isNumeric && fA && fB) {
    const valsA = toNumbers((respA as { extracted_json?: Record<string, unknown> }[]).map(r => r.extracted_json?.[fieldKey]))
    const valsB = toNumbers((respB as { extracted_json?: Record<string, unknown> }[]).map(r => r.extracted_json?.[fieldKey]))
    if (valsA.length > 1 && valsB.length > 1) {
      const tt = welchTTest(valsA, valsB)
      if (tt) { p = tt.p; d = tt.d }
    }
  } else if (!isText && !isBool && fA && fB) {
    // categorical (multiple_choice) — cramér's V across combined tables
    const sideA: string[] = []; const sideB: string[] = []
    for (const r of respA as { extracted_json?: Record<string, unknown> }[]) {
      const val = r.extracted_json?.[fieldKey]
      if (val !== undefined && val !== null && val !== '') { sideA.push('A'); sideB.push(String(val)) }
    }
    for (const r of respB as { extracted_json?: Record<string, unknown> }[]) {
      const val = r.extracted_json?.[fieldKey]
      if (val !== undefined && val !== null && val !== '') { sideA.push('B'); sideB.push(String(val)) }
    }
    const cramers = cramersV(sideA, sideB)
    if (cramers) { p = cramers.p; v = cramers.v }
  }

  const sig = p !== null && p < 0.05

  return (
    <div className={`px-5 py-4 ${sig ? 'bg-emerald-50/30' : ''}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">{description}</h4>
          <p className="text-xs text-gray-400 font-mono">{fieldKey} · {ftype}</p>
        </div>
        {p !== null && (
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${pBadge(p).bg} ${pBadge(p).fg}`}>
              {pBadge(p).label}
              {d !== null && isFinite(d) && <span className="opacity-70"> · d={d.toFixed(2)}</span>}
              {v !== null && isFinite(v) && <span className="opacity-70"> · V={v.toFixed(2)}</span>}
            </span>
            {d !== null && <span className="text-xs text-gray-400">{cohenLabel(d)} effect</span>}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <CompareCell field={fA} color="indigo" />
        <CompareCell field={fB} color="teal" />
      </div>

      {/* Delta row for numeric */}
      {isNumeric && fA && fB && (
        <div className="mt-3 flex items-center gap-4 text-xs bg-gray-50 rounded-lg px-3 py-2">
          <span className="text-gray-500">Δ mean:</span>
          <Delta a={(fA as FieldSummaryScale).mean} b={(fB as FieldSummaryScale).mean} />
          <span className="text-gray-500 ml-4">Δ median:</span>
          <Delta a={(fA as FieldSummaryScale).median} b={(fB as FieldSummaryScale).median} />
          <span className="text-gray-500 ml-4">Δ std:</span>
          <Delta a={(fA as FieldSummaryScale).std} b={(fB as FieldSummaryScale).std} />
        </div>
      )}
      {isBool && fA && fB && (
        <div className="mt-3 flex items-center gap-4 text-xs bg-gray-50 rounded-lg px-3 py-2">
          <span className="text-gray-500">Δ True %:</span>
          <Delta a={(fA as FieldSummaryBoolean).true_pct} b={(fB as FieldSummaryBoolean).true_pct} unit="%" />
        </div>
      )}
    </div>
  )
}

function CompareCell({ field, color }: { field: FieldSummary | undefined; color: 'indigo' | 'teal' }) {
  const ringColor = color === 'indigo' ? 'border-indigo-200' : 'border-teal-200'

  if (!field) {
    return (
      <div className={`rounded-lg border ${ringColor} bg-gray-50 px-3 py-2 text-xs text-gray-400 italic`}>
        Field not in this run
      </div>
    )
  }

  const ftype = field.type
  const isNumeric = ['scale', 'integer', 'float', 'number'].includes(ftype)
  const isBool = ftype === 'boolean'
  const isText = ['open_ended', 'text', 'string'].includes(ftype)

  if (isNumeric) {
    const f = field as FieldSummaryScale
    return (
      <div className={`rounded-lg border ${ringColor} bg-white px-3 py-2`}>
        <div className="flex items-center gap-3">
          <div>
            <div className={`text-xl font-bold ${color === 'indigo' ? 'text-indigo-600' : 'text-teal-600'}`}>{f.mean ?? '—'}</div>
            <div className="text-[10px] text-gray-400">mean (n={f.n})</div>
          </div>
          <div>
            <div className="text-sm text-gray-700">{f.median ?? '—'} <span className="text-gray-400 text-xs">med</span></div>
            <div className="text-xs text-gray-500">±{f.std ?? '—'}</div>
          </div>
        </div>
      </div>
    )
  }
  if (isBool) {
    const f = field as FieldSummaryBoolean
    return (
      <div className={`rounded-lg border ${ringColor} bg-white px-3 py-2`}>
        <div className={`text-xl font-bold ${color === 'indigo' ? 'text-indigo-600' : 'text-teal-600'}`}>{f.true_pct}%</div>
        <div className="text-[10px] text-gray-400">True ({f.true_count}/{f.n})</div>
      </div>
    )
  }
  if (isText) {
    const f = field as { n: number }
    return (
      <div className={`rounded-lg border ${ringColor} bg-white px-3 py-2`}>
        <div className="text-sm text-gray-700">{f.n} responses</div>
        <div className="text-xs text-gray-400">Open-ended — see detail view</div>
      </div>
    )
  }
  // categorical
  const f = field as FieldSummaryChoice
  const entries = Object.entries(f.distribution).slice(0, 3)
  return (
    <div className={`rounded-lg border ${ringColor} bg-white px-3 py-2 space-y-0.5`}>
      {entries.map(([opt, v]) => (
        <div key={opt} className="flex items-center justify-between text-xs">
          <span className="text-gray-700 truncate max-w-[60%]">{opt}</span>
          <span className={`font-medium ${color === 'indigo' ? 'text-indigo-600' : 'text-teal-600'}`}>{v.pct}%</span>
        </div>
      ))}
      {Object.keys(f.distribution).length > 3 && (
        <div className="text-[10px] text-gray-400">+{Object.keys(f.distribution).length - 3} more</div>
      )}
    </div>
  )
}

// ── Page export ───────────────────────────────────────────────────────────────

export default function ComparePage() {
  return (
    <Suspense fallback={<div className="flex items-center gap-2 text-sm text-gray-400 py-12"><Spin />Loading…</div>}>
      <CompareContent />
    </Suspense>
  )
}
