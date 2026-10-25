'use client'
import { useMemo, useState } from 'react'
import { FieldSummary, Respondent } from '@/lib/api'
import { Spin, parseTranscript } from './shared'

// ── Transcripts Tab ───────────────────────────────────────────────────────────

export function TranscriptsTab({ respondents, loading, schemaFields }: {
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

export function RespondentDeepDive({ respondent: r }: { respondent: Respondent }) {
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
