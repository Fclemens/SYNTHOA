'use client'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { api, Audience, Experiment, ExperimentProtocolBundle } from '@/lib/api'
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

  // Import protocol
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importAudienceId, setImportAudienceId] = useState('')
  const [pendingBundle, setPendingBundle] = useState<ExperimentProtocolBundle | null>(null)
  const [importing, setImporting] = useState(false)

  const [form, setForm] = useState({
    name: '',
    description: '',
    audience_id: '',
    execution_mode: 'pooled' as 'pooled' | 'dedicated',
    global_context: '',
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

  // ── Export ────────────────────────────────────────────────────────────────
  function handleExport(exp: Experiment) {
    window.location.href = api.exportExperimentProtocol(exp.id)
  }

  // ── Import — step 1: pick file ────────────────────────────────────────────
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const text = await file.text()
      const bundle = JSON.parse(text) as ExperimentProtocolBundle
      setPendingBundle(bundle)
      setImportAudienceId(audiences[0]?.id ?? '')
      setImportModalOpen(true)
    } catch {
      toast('Could not parse JSON file — make sure it was exported from this app', 'error')
    }
  }

  // ── Import — step 2: confirm audience and submit ──────────────────────────
  async function handleImportConfirm() {
    if (!pendingBundle || !importAudienceId) return
    try {
      setImporting(true)
      const result = await api.importExperimentProtocol(importAudienceId, pendingBundle)
      toast(
        `Imported "${result.name}" — ${result.questions_imported} questions, ${result.variables_imported} vars`,
        'success',
      )
      setImportModalOpen(false)
      setPendingBundle(null)
      await load()
      router.push(`/experiments/${result.experiment_id}`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Import failed', 'error')
    } finally {
      setImporting(false)
    }
  }

  // ── Create ────────────────────────────────────────────────────────────────
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
      setModalOpen(false)
      setForm({ name: '', description: '', audience_id: '', execution_mode: 'pooled', global_context: '' })
      toast('Experiment created', 'success')
      await load()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to create experiment', 'error')
    } finally {
      setCreating(false)
    }
  }

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

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Experiments</h1>
          <p className="mt-1 text-sm text-gray-500">Configure surveys and simulation parameters</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Hidden file input for import */}
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            variant="secondary"
            onClick={() => importInputRef.current?.click()}
          >
            ↑ Import Protocol
          </Button>
          <Button onClick={() => setModalOpen(true)}>+ New Experiment</Button>
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
                  <div className="flex items-center gap-1 shrink-0">
                    <Badge color={modeColor(exp.execution_mode)}>{exp.execution_mode}</Badge>
                    {/* Export */}
                    <button
                      onClick={e => { e.stopPropagation(); handleExport(exp) }}
                      className="text-gray-300 hover:text-indigo-500 transition-colors"
                      title="Export protocol as JSON"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    </button>
                    {/* Delete */}
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
                  {exp.variables?.length > 0 && (
                    <Badge color="yellow">{exp.variables.length} var{exp.variables.length !== 1 ? 's' : ''}</Badge>
                  )}
                </div>
                <p className="mt-3 text-xs text-gray-400">Created {fmtDate(exp.created_at)}</p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* Import Protocol Modal — pick target audience */}
      <Modal
        open={importModalOpen}
        onClose={() => { setImportModalOpen(false); setPendingBundle(null) }}
        title="Import Experiment Protocol"
      >
        <div className="space-y-4">
          {pendingBundle && (
            <div className="rounded-lg bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
              <p className="font-medium">{pendingBundle.experiment.name}</p>
              <p className="mt-1 text-indigo-600">
                {pendingBundle.questions.length} questions ·{' '}
                {pendingBundle.variables.length} vars ·{' '}
                {pendingBundle.output_schema.length} output fields ·{' '}
                {pendingBundle.experiment.execution_mode} mode
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Target Audience <span className="text-red-500">*</span>
            </label>
            <p className="mt-0.5 text-xs text-gray-500">
              The protocol will be linked to this audience. A new experiment is always created — the original is unchanged.
            </p>
            <select
              value={importAudienceId}
              onChange={e => setImportAudienceId(e.target.value)}
              className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">Select an audience…</option>
              {audiences.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => { setImportModalOpen(false); setPendingBundle(null) }}>
              Cancel
            </Button>
            <Button
              loading={importing}
              disabled={!importAudienceId}
              onClick={handleImportConfirm}
            >
              Import
            </Button>
          </div>
        </div>
      </Modal>

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

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" loading={creating}>Create Experiment</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
