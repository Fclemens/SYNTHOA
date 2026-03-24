'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, SimulationRun, Experiment } from '@/lib/api'

function statusColor(s: string) {
  if (s === 'completed') return 'bg-green-100 text-green-700'
  if (s === 'running') return 'bg-blue-100 text-blue-700'
  if (s === 'failed') return 'bg-red-100 text-red-700'
  if (s === 'cancelled') return 'bg-gray-100 text-gray-500'
  return 'bg-yellow-100 text-yellow-700'
}

export default function AnalysisPage() {
  const [runs, setRuns] = useState<SimulationRun[]>([])
  const [experiments, setExperiments] = useState<Record<string, Experiment>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([api.listRuns(undefined, 200), api.listExperiments()])
      .then(([r, exps]) => {
        setRuns(r)
        const map: Record<string, Experiment> = {}
        for (const e of exps) map[e.id] = e
        setExperiments(map)
      })
      .finally(() => setLoading(false))
  }, [])

  // Group runs by experiment
  const grouped: Record<string, SimulationRun[]> = {}
  for (const run of runs) {
    if (!grouped[run.experiment_id]) grouped[run.experiment_id] = []
    grouped[run.experiment_id].push(run)
  }

  const completedRuns = runs.filter(r => r.status === 'completed')

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Analysis</h1>
        <p className="mt-1 text-sm text-gray-500">
          Select a completed run to view statistical summaries and AI-generated insights.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-12">
          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          Loading runs…
        </div>
      ) : completedRuns.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 py-16 text-center">
          <svg className="mx-auto h-10 w-10 text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p className="text-sm font-medium text-gray-500">No completed runs yet</p>
          <p className="text-xs text-gray-400 mt-1">Run an experiment to see results here.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([expId, expRuns]) => {
            const exp = experiments[expId]
            const completed = expRuns.filter(r => r.status === 'completed')
            if (completed.length === 0) return null
            return (
              <div key={expId} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-3">
                  <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  <span className="text-sm font-semibold text-gray-700">
                    {exp?.name ?? expId}
                  </span>
                  <span className="text-xs text-gray-400">{completed.length} completed run{completed.length !== 1 ? 's' : ''}</span>
                </div>

                <div className="divide-y divide-gray-100">
                  {completed.map(run => (
                    <Link
                      key={run.id}
                      href={`/analysis/${run.id}`}
                      className="flex items-center gap-4 px-5 py-3.5 hover:bg-indigo-50 transition-colors group"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(run.status)}`}>
                            {run.status}
                          </span>
                          <span className="text-xs text-gray-400 font-mono">{run.id.slice(0, 8)}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-3 text-xs text-gray-500">
                          <span>{new Date(run.created_at).toLocaleString()}</span>
                          <span>·</span>
                          <span>{run.completed_tasks}/{run.total_tasks} respondents</span>
                          <span>·</span>
                          <span>${run.total_cost_usd.toFixed(3)}</span>
                          <span>·</span>
                          <span>{run.model_pass1}</span>
                        </div>
                      </div>
                      <svg className="h-4 w-4 text-gray-300 group-hover:text-indigo-500 flex-shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
