'use client'
import { useMemo, useState } from 'react'
import { FieldSummary, Respondent } from '@/lib/api'
import { welchTTest, oneWayANOVA, cramersV, toNumbers, tertileBuckets } from '@/lib/stats'
import { MiniStats, SigBadge, Spin, computeDrivers } from './shared'

// ── Segments Tab ──────────────────────────────────────────────────────────────

export interface Filter {
  key: string
  op: '=' | '≠' | '>' | '<'
  value: string
}

export function SegmentsTab({ respondents, loading, schemaFields }: {
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

export function KeyDriverAnalysis({ respondents, traitKeys, schemaFields }: {
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
