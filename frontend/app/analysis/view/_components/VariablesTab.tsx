'use client'
import { useState } from 'react'
import { FieldSummary, Respondent } from '@/lib/api'
import { welchTTest, oneWayANOVA, cramersV, cohenLabel, toNumbers } from '@/lib/stats'
import { MiniStats, SigBadge, computeNumericStats } from './shared'

// ── Variables Tab ─────────────────────────────────────────────────────────────

export function VariablesTab({ respondents, varKeys, fieldKeys, schemaFields }: {
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
      <div className="mb-5 flex items-center gap-4 glass rounded-[14px] px-5 py-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Stimulus variable</label>
          <select value={selectedVar} onChange={e => setSelectedVar(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none bg-panel-strong">
            {varKeys.map(k => <option key={k} value={k}>{'{' + k + '}'}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Output field</label>
          <select value={selectedField} onChange={e => setSelectedField(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none bg-panel-strong">
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
            <div key={val} className="glass rounded-[14px] p-4">
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
        <div className="mt-5 glass rounded-[14px] overflow-hidden">
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
