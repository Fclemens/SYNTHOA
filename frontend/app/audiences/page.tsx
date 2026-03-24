'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useRef } from 'react'
import { api, Audience, AudienceExportBundle } from '@/lib/api'
import { fmtDate } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { PageSpinner } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/Toast'

export default function AudiencesPage() {
  const router = useRouter()
  const { toast } = useToast()

  const [audiences, setAudiences] = useState<Audience[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Audience | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [duplicating, setDuplicating] = useState<string | null>(null)

  async function handleDuplicate(e: React.MouseEvent, audience: Audience) {
    e.stopPropagation()
    try {
      setDuplicating(audience.id)
      const copy = await api.duplicateAudience(audience.id)
      toast(`Duplicated as "${copy.name}"`, 'success')
      await load()
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Failed to duplicate', 'error')
    } finally {
      setDuplicating(null)
    }
  }
  const [form, setForm] = useState({ name: '', description: '', target_n: 100 })

  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    // Reset so the same file can be re-imported if needed
    e.target.value = ''
    try {
      setImporting(true)
      const text = await file.text()
      const bundle = JSON.parse(text) as AudienceExportBundle
      const result = await api.importAudience(bundle)
      toast(
        `Imported "${result.name}" — ${result.variables_imported} vars, ${result.personas_imported} personas`,
        'success',
      )
      await load()
      router.push(`/audiences/${result.audience_id}`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Import failed — check the file format', 'error')
    } finally {
      setImporting(false)
    }
  }

  async function load() {
    try {
      setLoading(true)
      setError(null)
      const data = await api.listAudiences()
      setAudiences(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load audiences')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    try {
      setCreating(true)
      await api.createAudience({ name: form.name.trim(), description: form.description.trim() || undefined })
      setModalOpen(false)
      setForm({ name: '', description: '', target_n: 100 })
      toast('Audience created', 'success')
      await load()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to create audience', 'error')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      setDeleting(true)
      await api.deleteAudience(deleteTarget.id)
      toast('Audience deleted', 'success')
      setDeleteTarget(null)
      await load()
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Failed to delete audience', 'error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Audiences</h1>
            <p className="mt-1 text-sm text-gray-500">Define demographic groups and their variable distributions</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Hidden file input for import */}
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleImport}
            />
            <Button
              variant="secondary"
              loading={importing}
              onClick={() => importInputRef.current?.click()}
            >
              ↑ Import JSON
            </Button>
            <Button onClick={() => setModalOpen(true)}>+ New Audience</Button>
          </div>
        </div>

        {/* Content */}
        {loading && <PageSpinner />}

        {error && (
          <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
            {error}
            <button className="ml-2 underline" onClick={load}>Retry</button>
          </div>
        )}

        {!loading && !error && audiences.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-white py-16 text-center">
            <p className="text-gray-500">No audiences yet. Create one to get started.</p>
            <Button className="mt-4" onClick={() => setModalOpen(true)}>Create your first audience</Button>
          </div>
        )}

        {!loading && !error && audiences.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {audiences.map(audience => (
              <Card
                key={audience.id}
                hover
                onClick={() => router.push(`/audiences/${audience.id}`)}
                className="relative"
              >
                <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
                  <button
                    onClick={e => handleDuplicate(e, audience)}
                    disabled={duplicating === audience.id}
                    className="rounded p-1 text-gray-300 hover:bg-indigo-50 hover:text-indigo-500 transition-colors disabled:opacity-40"
                    title="Duplicate audience"
                  >
                    {duplicating === audience.id
                      ? <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                      : <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-4 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                    }
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); setDeleteTarget(audience) }}
                    className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
                    title="Delete audience"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
                <CardBody>
                  <div className="flex items-start justify-between gap-2 pr-14">
                    <h2 className="font-semibold text-gray-900 leading-tight">{audience.name}</h2>
                    <span
                      title={`${audience.persona_count ?? 0} personas`}
                      className="flex items-center gap-1 text-xs shrink-0 text-gray-400"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-5.356-3.712M9 20H4v-2a4 4 0 015.356-3.712M15 7a4 4 0 11-8 0 4 4 0 018 0zm6 4a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      <span className={audience.persona_count ? 'text-green-600 font-medium' : ''}>
                        {audience.persona_count ?? 0}
                      </span>
                    </span>
                  </div>
                  {audience.description && (
                    <p className="mt-2 text-sm text-gray-500 line-clamp-2">{audience.description}</p>
                  )}
                  <p className="mt-3 text-xs text-gray-400">Created {fmtDate(audience.created_at)}</p>
                </CardBody>
              </Card>
            ))}
          </div>
        )}

      {/* Delete Confirmation Modal */}
      <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete Audience">
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            Are you sure you want to delete <strong>{deleteTarget?.name}</strong>?
            This will permanently remove all variables, correlations, personas, and any related experiments.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" loading={deleting} onClick={handleDelete}>Delete</Button>
          </div>
        </div>
      </Modal>

      {/* Create Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Audience">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="e.g. US Adults 25-54"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Description</label>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="Optional description of this audience segment"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Target N (personas)</label>
            <input
              type="number"
              min={1}
              value={form.target_n}
              onChange={e => setForm(f => ({ ...f, target_n: parseInt(e.target.value) || 100 }))}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" loading={creating}>Create Audience</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
