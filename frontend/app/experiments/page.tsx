'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, Audience, Experiment } from '@/lib/api'
import { fmtDate } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { PageSpinner } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/Toast'

export default function ExperimentsPage() {
  const router = useRouter()
  const { toast } = useToast()

  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [audiences, setAudiences] = useState<Audience[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<Experiment | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      setDeleting(true)
      await api.deleteExperiment(deleteTarget.id)
      toast('Experiment deleted', 'success')
      setDeleteTarget(null)
      await load()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error')
    } finally {
      setDeleting(false)
    }
  }
  const [form, setForm] = useState({
    name: '',
    description: '',
    audience_id: '',
    execution_mode: 'pooled' as 'pooled' | 'dedicated',
    global_context: '',
    synonym_injection_enabled: true,
  })

  async function load() {
    try {
      setLoading(true)
      setError(null)
      const [exps, auds] = await Promise.all([
        api.listExperiments(),
        api.listAudiences(),
      ])
      setExperiments(exps)
      setAudiences(auds)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load experiments')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function getAudienceName(audienceId: string): string {
    return audiences.find(a => a.id === audienceId)?.name ?? audienceId.slice(0, 8) + '…'
  }

  function modeColor(mode: string): 'blue' | 'purple' {
    return mode === 'pooled' ? 'blue' : 'purple'
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.audience_id) return
    try {
      setCreating(true)
      const exp = await api.createExperiment({
        name: form.name.trim(),
        audience_id: form.audience_id,
        global_context: form.global_context.trim() || undefined,
        execution_mode: form.execution_mode,
      })
      // Update synonym_injection_enabled if needed (PUT)
      if (!form.synonym_injection_enabled) {
        await api.updateExperiment(exp.id, { synonym_injection_enabled: false })
      }
      setModalOpen(false)
      setForm({ name: '', description: '', audience_id: '', execution_mode: 'pooled', global_context: '', synonym_injection_enabled: true })
      toast('Experiment created', 'success')
      await load()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to create experiment', 'error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Experiments</h1>
            <p className="mt-1 text-sm text-gray-500">Configure surveys and simulation parameters</p>
          </div>
          <Button onClick={() => setModalOpen(true)}>+ New Experiment</Button>
        </div>

        {/* Content */}
        {loading && <PageSpinner />}

        {error && (
          <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
            {error}
            <button className="ml-2 underline" onClick={load}>Retry</button>
          </div>
        )}

        {!loading && !error && experiments.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-white py-16 text-center">
            <p className="text-gray-500">No experiments yet. Create one to start simulating surveys.</p>
            <Button className="mt-4" onClick={() => setModalOpen(true)}>Create your first experiment</Button>
          </div>
        )}

        {!loading && !error && experiments.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {experiments.map(exp => (
              <Card
                key={exp.id}
                hover
                onClick={() => router.push(`/experiments/${exp.id}`)}
              >
                <CardBody>
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold text-gray-900 leading-tight">{exp.name}</h2>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge color={modeColor(exp.execution_mode)}>{exp.execution_mode}</Badge>
                      <button
                        onClick={e => { e.stopPropagation(); setDeleteTarget(exp) }}
                        className="text-gray-300 hover:text-red-500 transition-colors"
                        title="Delete experiment"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Audience: {getAudienceName(exp.audience_id)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {exp.questions?.length > 0 && (
                      <Badge color="gray">{exp.questions.length} question{exp.questions.length !== 1 ? 's' : ''}</Badge>
                    )}
                    {exp.synonym_injection_enabled && (
                      <Badge color="green">synonyms</Badge>
                    )}
                  </div>
                  <p className="mt-3 text-xs text-gray-400">Created {fmtDate(exp.created_at)}</p>
                </CardBody>
              </Card>
            ))}
          </div>
        )}

      {/* Delete Confirmation Modal */}
      <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete Experiment">
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            Are you sure you want to delete <strong>{deleteTarget?.name}</strong>?
            This will permanently remove the experiment, all its questions, variables, and simulation runs.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" loading={deleting} onClick={handleDelete}>Delete</Button>
          </div>
        </div>
      </Modal>

      {/* Create Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Experiment" size="lg">
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
              placeholder="e.g. Brand Perception Survey Q1"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Audience <span className="text-red-500">*</span>
            </label>
            <select
              required
              value={form.audience_id}
              onChange={e => setForm(f => ({ ...f, audience_id: e.target.value }))}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">Select an audience…</option>
              {audiences.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Execution Mode</label>
            <select
              value={form.execution_mode}
              onChange={e => setForm(f => ({ ...f, execution_mode: e.target.value as 'pooled' | 'dedicated' }))}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="pooled">Pooled — all questions in one LLM call (fast, cheaper)</option>
              <option value="dedicated">Dedicated — one LLM call per question, multi-turn interview (realistic, costlier)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Global Context</label>
            <textarea
              value={form.global_context}
              onChange={e => setForm(f => ({ ...f, global_context: e.target.value }))}
              rows={3}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="Background context shown to the model at the start of each interview…"
            />
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.synonym_injection_enabled}
                onChange={e => setForm(f => ({ ...f, synonym_injection_enabled: e.target.checked }))}
                className="rounded border-gray-300 text-indigo-600"
              />
              <span className="font-medium text-gray-700">Enable synonym injection</span>
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" loading={creating}>Create Experiment</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
