'use client'
import { useMemo, useState } from 'react'
import { Persona } from '@/lib/api'
import { fmtDate } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

const PAGE_SIZE = 25

/** Compact, searchable, paginated persona list; click a row for the full profile. */
export function PersonasTable({ personas, traitOrder, onDelete, deletingId }: {
  personas: Persona[]
  traitOrder: string[]
  onDelete: (id: string) => void
  deletingId: string | null
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<Persona | null>(null)

  const columns = useMemo(() => {
    const seen = new Set(traitOrder)
    const extra = Array.from(new Set(personas.flatMap(p => Object.keys(p.traits_json)))).filter(k => !seen.has(k))
    return [...traitOrder.filter(k => personas.some(p => k in p.traits_json)), ...extra]
  }, [personas, traitOrder])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return personas
    return personas.filter(p =>
      Object.values(p.traits_json).some(v => String(v).toLowerCase().includes(q))
      || (p.backstory ?? '').toLowerCase().includes(q))
  }, [personas, query])

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const rows = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); setPage(0) }}
          placeholder="Search traits or backstories…"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-300"
        />
        <span className="whitespace-nowrap text-xs text-gray-500">{filtered.length} of {personas.length}</span>
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-white/[0.03]">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">#</th>
                {columns.map(c => <th key={c} className="whitespace-nowrap px-4 py-2.5 text-left text-xs font-medium text-gray-500">{c}</th>)}
                <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Backstory</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((p, i) => (
                <tr key={p.id} onClick={() => setOpen(p)} className="cursor-pointer hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono text-xs text-gray-500">{current * PAGE_SIZE + i + 1}</td>
                  {columns.map(c => (
                    <td key={c} className="whitespace-nowrap px-4 py-2 font-mono text-xs text-gray-800">{String(p.traits_json[c] ?? '—')}</td>
                  ))}
                  <td className="max-w-xs truncate px-4 py-2 text-xs text-gray-500">{p.backstory ? p.backstory : <span className="italic">none</span>}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={columns.length + 2} className="px-4 py-6 text-center text-sm text-gray-500">No personas match “{query}”.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2.5 text-xs text-gray-500">
            <span>Page {current + 1} of {pages}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>← Previous</Button>
              <Button size="sm" variant="ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next →</Button>
            </div>
          </div>
        )}
      </Card>

      <Modal open={!!open} onClose={() => setOpen(null)} title="Persona" size="lg">
        {open && (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
              {Object.entries(open.traits_json).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-gray-100 py-1">
                  <dt className="text-gray-500">{k}</dt>
                  <dd className="font-mono text-gray-900">{String(v)}</dd>
                </div>
              ))}
            </dl>
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-[0.06em] text-gray-500">Backstory</p>
              {open.backstory
                ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-3 font-sans text-sm text-gray-800">{open.backstory}</pre>
                : <p className="text-sm text-gray-500">No backstory — the interview uses the trait list.</p>}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">Created {fmtDate(open.created_at)} · {open.id.slice(0, 8)}</span>
              <Button size="sm" variant="danger" loading={deletingId === open.id}
                onClick={() => { onDelete(open.id); setOpen(null) }}>
                Remove from panel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
