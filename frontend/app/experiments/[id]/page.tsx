'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { api, Experiment } from '@/lib/api'
import { fmtDate } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { PageSpinner } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/Toast'

import { OverviewTab } from './_components/OverviewTab'
import { VariablesTab } from './_components/VariablesTab'
import { QuestionsTab } from './_components/QuestionsTab'
import { SchemaTab } from './_components/SchemaTab'
import { LaunchTab } from './_components/LaunchTab'
import { RunsTab } from './_components/RunsTab'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { InlineEdit } from '@/components/ui/InlineEdit'
import { OverflowMenu } from '@/components/ui/OverflowMenu'

type Tab = 'overview' | 'variables' | 'questions' | 'schema' | 'launch' | 'runs'

// ── Main Page ────────────────────────────────────────────────────────────────

export default function ExperimentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  const [experiment, setExperiment] = useState<Experiment | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const t = searchParams.get('tab')
    return (t === 'launch' || t === 'variables' || t === 'questions' || t === 'schema' || t === 'runs') ? t : 'overview'
  })
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [runCount, setRunCount] = useState(0)
  const [audienceName, setAudienceName] = useState<string | null>(null)

  async function handleDelete() {
    try {
      setDeleting(true)
      await api.deleteExperiment(id)
      toast('Experiment deleted', 'success')
      router.push('/experiments')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error')
      setDeleting(false)
    }
  }

  async function loadExperiment() {
    try {
      setError(null)
      const exp = await api.getExperiment(id)
      setExperiment(exp)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load experiment')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadExperiment() }, [id])
  useEffect(() => { api.listRuns(id, 200).then(r => setRunCount(r.length)).catch(() => {}) }, [id])
  useEffect(() => {
    if (experiment?.audience_id) api.getAudience(experiment.audience_id).then(a => setAudienceName(a.name)).catch(() => {})
  }, [experiment?.audience_id])

  async function handleRename(name: string) {
    if (!name) return
    try {
      setExperiment(await api.updateExperiment(id, { name }))
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Rename failed', 'error')
    }
  }

  if (loading) return <PageSpinner />

  if (error && !experiment) {
    return (
      <div className="py-8">
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button className="ml-2 underline" onClick={loadExperiment}>Retry</button>
        </div>
      </div>
    )
  }

  if (!experiment) return null

  // Tabs follow the workflow order; `todo` marks a step that still needs attention.
  const tabs: { key: Tab; label: string; todo?: boolean }[] = [
    { key: 'overview', label: 'Setup' },
    { key: 'variables', label: `Variables (${experiment.dist_variables?.length ?? 0})` },
    { key: 'questions', label: `Questions (${experiment.questions?.length ?? 0})`, todo: !experiment.questions?.length },
    { key: 'schema', label: 'Output Schema', todo: !experiment.output_schemas?.[0]?.schema_json?.length },
    { key: 'launch', label: 'Launch' },
    { key: 'runs', label: `Runs${runCount ? ` (${runCount})` : ''}` },
  ]

  return (
    <div className="space-y-6">
        <Breadcrumbs items={[{ label: 'Experiments', href: '/experiments' }, { label: experiment.name }]} />

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <InlineEdit value={experiment.name} onSave={handleRename} className="text-2xl font-bold text-gray-900" />
              <Badge color={experiment.execution_mode === 'pooled' ? 'blue' : 'purple'}>{experiment.execution_mode}</Badge>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              {audienceName && <>Audience <Link href={`/audiences/${experiment.audience_id}`} className="text-indigo-400 hover:underline">{audienceName}</Link> · </>}
              Created {fmtDate(experiment.created_at)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={() => setActiveTab('launch')}>New run</Button>
            <OverflowMenu items={[
              { label: 'Export protocol (JSON)', onClick: () => window.open(api.exportExperimentProtocol(experiment.id), '_blank') },
              { label: 'Delete experiment…', onClick: () => setDeleteConfirm(true), danger: true },
            ]} />
          </div>
        </div>

        {/* Delete confirmation modal */}
        <Modal open={deleteConfirm} onClose={() => setDeleteConfirm(false)} title="Delete Experiment">
          <div className="space-y-4">
            <p className="text-sm text-gray-700">
              Are you sure you want to delete <strong>{experiment.name}</strong>?
              This will permanently remove all questions, variables, and simulation runs.
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="secondary" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
              <Button variant="danger" loading={deleting} onClick={handleDelete}>Delete</Button>
            </div>
          </div>
        </Modal>

        {/* Tabs */}
        <div className="flex border-b border-gray-200">
          {tabs.map((tab, i) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab.key
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.key !== 'runs' && <span className="text-xs text-gray-400">{i + 1}</span>}
              {tab.label}
              {tab.todo && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Needs attention" />}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <OverviewTab experiment={experiment} onSaved={loadExperiment} />
        )}
        {activeTab === 'variables' && (
          <VariablesTab experiment={experiment} onChanged={loadExperiment} />
        )}
        {activeTab === 'questions' && (
          <QuestionsTab experiment={experiment} onChanged={loadExperiment} />
        )}
        {activeTab === 'schema' && (
          <SchemaTab experiment={experiment} onChanged={loadExperiment} />
        )}
        {activeTab === 'launch' && (
          <LaunchTab experiment={experiment} onGoTo={setActiveTab} />
        )}
        {activeTab === 'runs' && (
          <RunsTab experiment={experiment} onNewRun={() => setActiveTab('launch')} onCount={setRunCount} />
        )}
    </div>
  )
}
