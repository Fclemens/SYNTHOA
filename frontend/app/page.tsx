'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, Audience, Experiment, SimulationRun } from '@/lib/api'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { PageSpinner } from '@/components/ui/Spinner'
import { fmtDateTime, runStatusColor, pct } from '@/lib/utils'
import { ProgressBar } from '@/components/ui/ProgressBar'

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <Card>
      <CardBody>
        <p className="text-sm text-gray-500">{label}</p>
        <p className={`mt-1 text-3xl font-bold ${color ?? 'text-gray-900'}`}>{value}</p>
        {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
      </CardBody>
    </Card>
  )
}

export default function Dashboard() {
  const [audiences, setAudiences] = useState<Audience[]>([])
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [runs, setRuns] = useState<SimulationRun[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.listAudiences(),
      api.listExperiments(),
      api.listRuns ? api.listRuns() : Promise.resolve([]),
    ])
      .then(([a, e, r]) => { setAudiences(a); setExperiments(e); setRuns(r as SimulationRun[]) })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <PageSpinner />

  const runningRuns = runs.filter(r => r.status === 'running')
  const completedRuns = runs.filter(r => r.status === 'completed')
  const totalTasks = runs.reduce((s, r) => s + (r.total_tasks ?? 0), 0)

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">Overview of your simulation workspace</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Audiences" value={audiences.length} sub="defined segments" color="text-indigo-600" />
        <StatCard label="Experiments" value={experiments.length} sub="survey designs" color="text-purple-600" />
        <StatCard label="Simulation Runs" value={runs.length} sub={`${runningRuns.length} active`} color="text-blue-600" />
        <StatCard label="Total Tasks" value={totalTasks} sub={`${completedRuns.length} runs completed`} color="text-green-600" />
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Link href="/audiences">
          <Card hover className="border-2 border-dashed border-gray-200 transition-colors hover:border-indigo-300">
            <CardBody className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-gray-900">Create Audience</p>
                <p className="text-sm text-gray-500">Define a synthetic respondent segment</p>
              </div>
            </CardBody>
          </Card>
        </Link>

        <Link href="/experiments">
          <Card hover className="border-2 border-dashed border-gray-200 transition-colors hover:border-purple-300">
            <CardBody className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-50 text-purple-600">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-gray-900">Create Experiment</p>
                <p className="text-sm text-gray-500">Build a survey and launch a simulation</p>
              </div>
            </CardBody>
          </Card>
        </Link>
      </div>

      {/* Recent runs */}
      {runs.length > 0 && (
        <div>
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Recent Runs</h2>
          <div className="space-y-3">
            {runs.slice(0, 8).map(run => {
              const progress = pct(
                (run.completed_tasks ?? 0) + (run.failed_tasks ?? 0),
                run.total_tasks ?? 1
              )
              return (
                <Link key={run.id} href={`/runs/${run.id}`}>
                  <Card hover>
                    <CardBody className="flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-gray-900 truncate">{run.id.slice(0, 8)}…</p>
                          <Badge color={runStatusColor(run.status)}>{run.status}</Badge>
                        </div>
                        <div className="mt-2">
                          <ProgressBar
                            value={progress}
                            color={run.status === 'failed' ? 'red' : run.status === 'completed' ? 'green' : 'indigo'}
                            size="sm"
                          />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-medium text-gray-700">
                          {run.completed_tasks ?? 0}/{run.total_tasks ?? 0} tasks
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {run.created_at ? fmtDateTime(run.created_at) : '—'}
                        </p>
                      </div>
                    </CardBody>
                  </Card>
                </Link>
              )
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {audiences.length === 0 && experiments.length === 0 && (
        <Card className="border-dashed">
          <CardBody className="py-12 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-50">
              <svg className="h-8 w-8 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
              </svg>
            </div>
            <p className="text-lg font-semibold text-gray-700">No data yet</p>
            <p className="mt-1 text-sm text-gray-400">Start by creating an audience, then design an experiment.</p>
            <div className="mt-6 flex justify-center gap-3">
              <Link href="/audiences">
                <span className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
                  Create Audience
                </span>
              </Link>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
