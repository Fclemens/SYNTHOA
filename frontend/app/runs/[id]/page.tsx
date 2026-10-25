'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, hasResults, isRunActive, SimulationRun, SimulationTaskSummary, SimulationTaskDetail } from '@/lib/api'
import { usePolling } from '@/lib/usePolling'
import { fmtDateTime, fmtCost, fmtTokens, runDetails, runLabel, runStatusColor, runStatusLabel, taskStatusColor, pct } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { InlineEdit } from '@/components/ui/InlineEdit'
import { OverflowMenu } from '@/components/ui/OverflowMenu'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { PageSpinner } from '@/components/ui/Spinner'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { useToast } from '@/components/ui/Toast'

const POLL_INTERVAL = 3000

/** Pass 2 never starts when the interview failed or was cancelled — say so instead of "pending". */
function pass2Shown(t: { pass1_status: string; pass2_status: string }): string {
  return t.pass2_status === 'pending' && (t.pass1_status === 'failed' || t.pass1_status === 'cancelled') ? 'skipped' : t.pass2_status
}

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { toast } = useToast()

  const [run, setRun] = useState<SimulationRun | null>(null)
  const [tasks, setTasks] = useState<SimulationTaskSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Task detail modal
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [taskDetail, setTaskDetail] = useState<SimulationTaskDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  // Action states
  const [retrying, setRetrying] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [reExtracting, setReExtracting] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [runData, tasksData] = await Promise.all([
        api.getRun(id),
        api.listTasks(id, 0, 200),
      ])
      setRun(runData)
      setTasks(tasksData)
      setError(null)
      return runData
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load run')
      return null
    }
  }, [id])

  // Initial load
  useEffect(() => {
    setLoading(true)
    loadData().finally(() => setLoading(false))
  }, [loadData])

  // Poll while the run is active; actions kick() it to pick up the new state at once
  const kick = usePolling(
    async () => { const r = await loadData(); return !!r && isRunActive(r.status) },
    { intervalMs: POLL_INTERVAL, enabled: !!run && isRunActive(run.status) },
    run?.status,
  )

  async function openTaskDetail(taskId: string) {
    setSelectedTaskId(taskId)
    setTaskDetail(null)
    setLoadingDetail(true)
    try {
      const detail = await api.getTask(id, taskId)
      setTaskDetail(detail)
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to load task', 'error')
    } finally {
      setLoadingDetail(false)
    }
  }

  function closeTaskDetail() {
    setSelectedTaskId(null)
    setTaskDetail(null)
  }

  async function handleRename(name: string) {
    try {
      setRun(await api.renameRun(id, name))
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Rename failed', 'error')
    }
  }

  async function handleRetryFailed() {
    try {
      setRetrying(true)
      await api.retryFailed(id)
      toast('Retrying failed tasks', 'info')
      await loadData()
      kick()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Retry failed', 'error')
    } finally {
      setRetrying(false)
    }
  }

  async function handleCancel() {
    setConfirmCancel(false)
    try {
      setCancelling(true)
      await api.cancelRun(id)
      toast('Run cancelled', 'info')
      await loadData()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Cancel failed', 'error')
    } finally {
      setCancelling(false)
    }
  }

  async function handleResume() {
    try {
      setResuming(true)
      await api.resumeRun(id)
      toast('Run resumed', 'success')
      await loadData()
      kick()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Resume failed', 'error')
    } finally {
      setResuming(false)
    }
  }

  async function handleReExtract() {
    try {
      setReExtracting(true)
      await api.reExtract(id)
      toast('Re-extraction started', 'info')
      await loadData()
      kick()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Re-extract failed', 'error')
    } finally {
      setReExtracting(false)
    }
  }

  if (loading) return <PageSpinner />

  if (error && !run) {
    return (
      <div className="py-8">
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button className="ml-2 underline" onClick={() => loadData()}>Retry</button>
        </div>
      </div>
    )
  }

  if (!run) return null

  const progress = pct(run.completed_tasks, run.total_tasks)
  const failureCounts: Record<string, number> = {}
  for (const t of tasks) {
    const reason = t.pass1_status === 'failed' ? `Interview: ${t.pass1_error ?? 'unknown error'}`
      : t.pass2_status === 'failed' ? `Extraction: ${t.pass2_error ?? 'unknown error'}` : null
    if (reason) failureCounts[reason.slice(0, 300)] = (failureCounts[reason.slice(0, 300)] ?? 0) + 1
  }
  const failureGroups = Object.entries(failureCounts).sort((a, b) => b[1] - a[1])
  const progressColor: 'indigo' | 'green' | 'red' | 'yellow' =
    run.status === 'failed' ? 'red' : run.status === 'completed' ? 'green'
      : run.status === 'completed_with_errors' ? 'yellow' : 'indigo'

  return (
    <div className="space-y-6">
        <Breadcrumbs items={[
          { label: 'Experiments', href: '/experiments' },
          { label: run.experiment_name ?? 'Experiment', href: `/experiments/${run.experiment_id}` },
          { label: runLabel(run) },
        ]} />

        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <InlineEdit
                value={run.name ?? ''}
                placeholder={run.run_number ? `Run #${run.run_number}` : 'Untitled run'}
                onSave={handleRename}
                className="text-2xl font-bold text-gray-900"
              />
              <Badge color={runStatusColor(run.status)}>{runStatusLabel(run.status)}</Badge>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              {run.name && run.run_number ? `Run #${run.run_number} · ` : ''}{runDetails(run)} · {fmtDateTime(run.created_at)}
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {run.failed_tasks > 0 && !isRunActive(run.status) && (
              <Button size="sm" variant="outline" loading={retrying} onClick={handleRetryFailed}>
                Retry failed ({run.failed_tasks})
              </Button>
            )}
            {isRunActive(run.status) && (
              <Button size="sm" variant="danger" loading={cancelling} onClick={() => setConfirmCancel(true)}>
                Cancel
              </Button>
            )}
            {run.status === 'cancelled' && (
              <Button size="sm" variant="outline" loading={resuming} onClick={handleResume}>
                Resume
              </Button>
            )}
            {run.completed_tasks > 0 && (
              <Link href={`/analysis/${id}`}><Button size="sm">View results</Button></Link>
            )}
            <OverflowMenu items={[
              { label: 'Export CSV', onClick: () => window.open(api.exportRun(id, 'csv'), '_blank') },
              { label: 'Export Excel', onClick: () => window.open(api.exportRun(id, 'xlsx'), '_blank') },
              { label: reExtracting ? 'Re-extracting…' : 'Re-extract with latest schema', onClick: handleReExtract,
                disabled: isRunActive(run.status) || !tasks.some(t => t.pass1_status === 'completed') || reExtracting },
            ]} />
          </div>
        </div>

        {/* Progress */}
        <Card>
          <CardBody>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium text-gray-700">
                  {run.completed_tasks} / {run.total_tasks} tasks complete
                </span>
                {run.failed_tasks > 0 && (
                  <span className="text-sm font-medium text-red-600">
                    {run.failed_tasks} failed
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-sm text-gray-500">
                <span>Cost: <span className="font-medium text-gray-700">{fmtCost(run.total_cost_usd)}</span></span>
              </div>
            </div>
            <ProgressBar value={progress} color={progressColor} showLabel size="md" />
          </CardBody>
        </Card>

        {/* Failures grouped by cause */}
        {failureGroups.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <h2 className="font-semibold text-gray-800">Why tasks failed</h2>
            </CardHeader>
            <CardBody className="space-y-2">
              {failureGroups.map(([reason, count]) => (
                <div key={reason} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 rounded bg-red-50 px-2 py-0.5 text-xs font-semibold tabular-nums text-red-700">{count}×</span>
                  <span className="break-all text-gray-700">{reason}</span>
                </div>
              ))}
              <p className="pt-1 text-xs text-gray-400">
                Retrying re-runs only what failed: interviews that failed are redone, failed extractions re-run on the existing transcript.
              </p>
            </CardBody>
          </Card>
        )}

        {/* Tasks Table */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Tasks</h2>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Task ID</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Persona</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Pass 1</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Pass 2</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Drift</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {tasks.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-gray-400 text-sm">
                        No tasks yet
                      </td>
                    </tr>
                  ) : (
                    tasks.map(task => {
                      const taskCost = (task.pass1_cost_usd ?? 0) + (task.pass2_cost_usd ?? 0)
                      return (
                        <tr
                          key={task.id}
                          className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => openTaskDetail(task.id)}
                        >
                          <td className="px-4 py-3">
                            <span className="font-mono text-xs text-gray-500">{task.id.slice(0, 8)}…</span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-mono text-xs text-gray-500">{task.persona_id.slice(0, 8)}…</span>
                          </td>
                          <td className="px-4 py-3">
                            <Badge color={taskStatusColor(task.pass1_status)}>{task.pass1_status}</Badge>
                          </td>
                          <td className="px-4 py-3">
                            <Badge color={taskStatusColor(pass2Shown(task))}>{pass2Shown(task)}</Badge>
                          </td>
                          <td className="px-4 py-3">
                            {task.drift_flagged ? (
                              <Badge color="yellow">flagged</Badge>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-600">{fmtCost(taskCost)}</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>


      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this run?"
        confirmLabel="Cancel run"
        danger
        loading={cancelling}
        onConfirm={handleCancel}
        onClose={() => setConfirmCancel(false)}
      >
        Interviews already finished are kept. You can resume the run later to finish the rest.
      </ConfirmDialog>

      {/* Task Detail Modal */}
      <Modal
        open={selectedTaskId !== null}
        onClose={closeTaskDetail}
        title={`Task ${selectedTaskId?.slice(0, 8) ?? ''}…`}
        size="xl"
      >
        {loadingDetail ? (
          <div className="flex items-center justify-center py-12">
            <svg className="h-8 w-8 animate-spin text-indigo-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : taskDetail ? (
          <TaskDetailContent detail={taskDetail} />
        ) : (
          <p className="text-sm text-gray-500 py-4">Failed to load task details.</p>
        )}
      </Modal>
    </div>
  )
}

// ── Task Detail Content ───────────────────────────────────────────────────────

function TaskDetailContent({ detail }: { detail: SimulationTaskDetail }) {
  const [activeSection, setActiveSection] = useState<'prompt' | 'transcript' | 'extracted' | 'persona'>('extracted')

  const sections = [
    { key: 'extracted' as const, label: 'Extracted answers' },
    { key: 'transcript' as const, label: 'Transcript' },
    { key: 'persona' as const, label: 'Persona' },
    { key: 'prompt' as const, label: 'Prompt' },
  ]

  const totalCost = (detail.pass1_cost_usd ?? 0) + (detail.pass2_cost_usd ?? 0)

  return (
    <div className="space-y-4">
      {/* Status badges */}
      <div className="flex flex-wrap gap-2">
        <Badge color={taskStatusColor(detail.pass1_status)}>P1: {detail.pass1_status}</Badge>
        <Badge color={taskStatusColor(pass2Shown(detail))}>P2: {pass2Shown(detail)}</Badge>
        {detail.drift_flagged && <Badge color="yellow">Drift Flagged</Badge>}
        <span className="text-xs text-gray-500 self-center">Cost: {fmtCost(totalCost)}</span>
        {detail.pass1_tokens_in != null && (
          <span className="text-xs text-gray-500 self-center">
            Tokens: {fmtTokens((detail.pass1_tokens_in ?? 0) + (detail.pass1_tokens_out ?? 0))}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        {sections.map(s => (
          <button
            key={s.key}
            onClick={() => setActiveSection(s.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeSection === s.key
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeSection === 'extracted' && (
        <div className="space-y-3">
          {detail.extracted_json ? (
            <>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100">
                  {Object.entries(detail.extracted_json).map(([k, v]) => (
                    <tr key={k}>
                      <td className="py-1.5 pr-4 font-mono text-xs text-indigo-700">{k}</td>
                      <td className="py-1.5 text-gray-800">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.extraction_confidence && Object.keys(detail.extraction_confidence).length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-gray-600 mb-2">Confidence Scores</h4>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(detail.extraction_confidence).map(([k, v]) => (
                      <div key={k} className="flex justify-between text-xs bg-gray-50 rounded px-3 py-1.5">
                        <span className="text-gray-600">{k}</span>
                        <span className={`font-medium ${v >= 0.8 ? 'text-green-600' : v >= 0.5 ? 'text-yellow-600' : 'text-red-600'}`}>
                          {(v * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-400 italic">No extracted data yet</p>
          )}
        </div>
      )}

      {activeSection === 'transcript' && (
        detail.raw_transcript ? (
          <pre className="rounded-lg bg-gray-50 p-4 text-xs text-gray-700 whitespace-pre-wrap overflow-auto max-h-96">
            {detail.raw_transcript}
          </pre>
        ) : (
          <p className="text-sm text-gray-400 italic">No transcript available</p>
        )
      )}

      {activeSection === 'persona' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(detail.persona_traits ?? {}).map(([k, v]) => (
              <span key={k} className="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-800">{k}: {String(v)}</span>
            ))}
          </div>
          {Object.keys(detail.injected_vars ?? {}).length > 0 && (
            <p className="text-xs text-gray-500">
              Variables: {Object.entries(detail.injected_vars).map(([k, v]) => `${k} = ${String(v)}`).join(', ')}
            </p>
          )}
          {detail.persona_backstory && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-4 text-xs text-gray-700">{detail.persona_backstory}</pre>
          )}
        </div>
      )}

      {activeSection === 'prompt' && (
        detail.pass1_prompt ? (
          <pre className="rounded-lg bg-gray-50 p-4 text-xs text-gray-700 whitespace-pre-wrap overflow-auto max-h-96">
            {detail.pass1_prompt}
          </pre>
        ) : (
          <p className="text-sm text-gray-400 italic">Prompt not available</p>
        )
      )}

      {/* Errors */}
      {(detail.pass1_error || detail.pass2_error) && (
        <div className="rounded-lg bg-red-50 p-3 space-y-1">
          {detail.pass1_error && <p className="text-xs text-red-700"><span className="font-medium">P1 Error:</span> {detail.pass1_error}</p>}
          {detail.pass2_error && <p className="text-xs text-red-700"><span className="font-medium">P2 Error:</span> {detail.pass2_error}</p>}
        </div>
      )}
    </div>
  )
}
