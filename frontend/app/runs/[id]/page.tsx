'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, SimulationRun, SimulationTaskSummary, SimulationTaskDetail } from '@/lib/api'
import { fmtDateTime, fmtCost, fmtTokens, runStatusColor, taskStatusColor, pct } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { PageSpinner } from '@/components/ui/Spinner'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { useToast } from '@/components/ui/Toast'

const POLL_INTERVAL = 3000

function isTerminal(status: string) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
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

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

  // Polling
  useEffect(() => {
    if (run && !isTerminal(run.status)) {
      pollingRef.current = setInterval(async () => {
        const updated = await loadData()
        if (updated && isTerminal(updated.status)) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current)
            pollingRef.current = null
          }
        }
      }, POLL_INTERVAL)
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
  }, [run?.status, loadData])

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

  async function handleRetryFailed() {
    try {
      setRetrying(true)
      await api.retryFailed(id)
      toast('Retrying failed tasks', 'info')
      await loadData()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Retry failed', 'error')
    } finally {
      setRetrying(false)
    }
  }

  async function handleCancel() {
    if (!confirm('Cancel this simulation run?')) return
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
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Re-extract failed', 'error')
    } finally {
      setReExtracting(false)
    }
  }

  if (loading) return <PageSpinner />

  if (error && !run) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button className="ml-2 underline" onClick={() => loadData()}>Retry</button>
        </div>
      </div>
    )
  }

  if (!run) return null

  const progress = pct(run.completed_tasks, run.total_tasks)
  const progressColor: 'indigo' | 'green' | 'red' = run.status === 'failed' ? 'red' : run.status === 'completed' ? 'green' : 'indigo'

  return (
    <div className="space-y-6 max-w-4xl">
        {/* Back link */}
        <Link href={`/experiments/${run.experiment_id}?tab=launch`} className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800 mb-6">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Experiment
        </Link>

        {/* Header */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-gray-900 font-mono">
                Run {run.id.slice(0, 8)}…
              </h1>
              <Badge color={runStatusColor(run.status)}>{run.status}</Badge>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              Experiment:{' '}
              <Link href={`/experiments/${run.experiment_id}`} className="text-indigo-600 hover:underline">
                {run.experiment_id.slice(0, 8)}…
              </Link>
            </p>
            <p className="text-xs text-gray-400 mt-1">{fmtDateTime(run.created_at)}</p>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {run.failed_tasks > 0 && (
              <Button size="sm" variant="outline" loading={retrying} onClick={handleRetryFailed}>
                Retry Failed ({run.failed_tasks})
              </Button>
            )}
            {(run.status === 'running' || run.status === 'pending') && (
              <Button size="sm" variant="danger" loading={cancelling} onClick={handleCancel}>
                Cancel
              </Button>
            )}
            {(run.status === 'cancelled' || run.status === 'failed') && (
              <Button size="sm" variant="outline" loading={resuming} onClick={handleResume}>
                Resume
              </Button>
            )}
            {isTerminal(run.status) && (
              <Button size="sm" variant="outline" loading={reExtracting} onClick={handleReExtract}>
                Re-extract
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => window.open(api.exportRun(id, 'csv'), '_blank')}>
              Export CSV
            </Button>
            <Button size="sm" variant="secondary" onClick={() => {
              const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
              window.open(`${base}/api/runs/${id}/export?format=json`, '_blank')
            }}>
              Export JSON
            </Button>
          </div>
        </div>

        {/* Progress */}
        <Card className="mb-6">
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
                            <Badge color={taskStatusColor(task.pass2_status)}>{task.pass2_status}</Badge>
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

        {/* Results Summary — shown when run is completed and tasks have extracted data */}
        {run.status === 'completed' && tasks.length > 0 && (
          <ResultsSummary runId={id} tasks={tasks} />
        )}

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
  const [activeSection, setActiveSection] = useState<'prompt' | 'transcript' | 'extracted'>('extracted')

  const sections = [
    { key: 'extracted' as const, label: 'Extracted JSON' },
    { key: 'transcript' as const, label: 'Transcript' },
    { key: 'prompt' as const, label: 'Prompt' },
  ]

  const totalCost = (detail.pass1_cost_usd ?? 0) + (detail.pass2_cost_usd ?? 0)

  return (
    <div className="space-y-4">
      {/* Status badges */}
      <div className="flex flex-wrap gap-2">
        <Badge color={taskStatusColor(detail.pass1_status)}>P1: {detail.pass1_status}</Badge>
        <Badge color={taskStatusColor(detail.pass2_status)}>P2: {detail.pass2_status}</Badge>
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
              <pre className="rounded-lg bg-gray-900 p-4 text-xs text-green-400 overflow-auto max-h-64">
                {JSON.stringify(detail.extracted_json, null, 2)}
              </pre>
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

// ── Results Summary ───────────────────────────────────────────────────────────

function ResultsSummary({ runId, tasks }: { runId: string; tasks: SimulationTaskSummary[] }) {
  const { toast } = useToast()
  const [details, setDetails] = useState<SimulationTaskDetail[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  async function loadDetails() {
    setLoading(true)
    try {
      // Load up to 50 task details in parallel (batched)
      const completedIds = tasks
        .filter(t => t.pass1_status === 'completed')
        .slice(0, 50)
        .map(t => t.id)

      const detailResults = await Promise.allSettled(
        completedIds.map(tid => api.getTask(runId, tid))
      )
      const loaded = detailResults
        .filter((r): r is PromiseFulfilledResult<SimulationTaskDetail> => r.status === 'fulfilled')
        .map(r => r.value)
        .filter(d => d.extracted_json != null)

      setDetails(loaded)
      setLoaded(true)
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to load results', 'error')
    } finally {
      setLoading(false)
    }
  }

  // Get all unique schema keys across task details
  const schemaKeys = Array.from(
    new Set(details.flatMap(d => Object.keys(d.extracted_json ?? {})))
  )

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-800">Results Summary</h2>
        {!loaded && (
          <Button size="sm" variant="outline" loading={loading} onClick={loadDetails}>
            Load Results
          </Button>
        )}
      </div>

      {!loaded ? (
        <Card>
          <CardBody>
            <p className="text-sm text-gray-500 text-center py-4">
              Click &ldquo;Load Results&rdquo; to view extracted data across all completed tasks.
            </p>
          </CardBody>
        </Card>
      ) : details.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-gray-400 text-center py-4">No extracted results available.</p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <span className="text-sm text-gray-500">{details.length} tasks with extracted data</span>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-3 py-2.5 text-left font-medium text-gray-600 sticky left-0 bg-gray-50">Task</th>
                  {schemaKeys.map(k => (
                    <th key={k} className="px-3 py-2.5 text-left font-medium text-gray-600">{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {details.map(d => (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-gray-400 sticky left-0 bg-white">{d.id.slice(0, 8)}…</td>
                    {schemaKeys.map(k => {
                      const val = d.extracted_json?.[k]
                      const conf = d.extraction_confidence?.[k]
                      return (
                        <td key={k} className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <span className="text-gray-700">
                              {val == null ? '—' : typeof val === 'object' ? JSON.stringify(val) : String(val)}
                            </span>
                            {conf != null && (
                              <span className={`text-xs ${conf >= 0.8 ? 'text-green-500' : conf >= 0.5 ? 'text-yellow-500' : 'text-red-500'}`}>
                                ({(conf * 100).toFixed(0)}%)
                              </span>
                            )}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
