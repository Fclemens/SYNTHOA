'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { api, SimulationRun } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { PruneRunsModal } from '@/components/PruneRunsModal'

const POLL_MS = 3000
const MAX_SHOWN = 5

type RunProgress = {
  p1_running: number; p1_done: number
  p2_running: number; p2_done: number
  failed: number; total: number
}

function isActive(s: string) { return s === 'running' || s === 'pending' }

function statusDot(status: string) {
  if (status === 'completed') return 'bg-green-500'
  if (status === 'failed')    return 'bg-red-500'
  if (status === 'cancelled') return 'bg-gray-400'
  if (status === 'running')   return 'bg-indigo-500 animate-pulse'
  return 'bg-yellow-400 animate-pulse' // pending
}

export default function ActiveRunsTracker() {
  const { toast } = useToast()
  const [runs, setRuns]           = useState<SimulationRun[]>([])
  const [progress, setProgress]   = useState<Record<string, RunProgress>>({})
  const [pruneModalOpen, setPruneModalOpen] = useState(false)
  const [pruning, setPruning]     = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function poll(): Promise<boolean> {
    try {
      const all = await api.listRuns(undefined, MAX_SHOWN)
      setRuns(all.slice(0, MAX_SHOWN))

      // Fetch detailed task progress for every active run
      const active = all.filter(r => isActive(r.status))
      if (active.length === 0) return false   // signal: no active runs
      const results = await Promise.allSettled(
        active.map(r => api.getRunProgress(r.id).then(p => ({ id: r.id, p })))
      )
      const map: Record<string, RunProgress> = {}
      for (const res of results) {
        if (res.status === 'fulfilled') map[res.value.id] = res.value.p
      }
      setProgress(prev => ({ ...prev, ...map }))
      return true   // signal: still have active runs
    } catch {
      // backend may be restarting
      return true   // keep polling so we can recover
    }
  }

  async function handlePruneConfirm(includeCompleted: boolean) {
    try {
      setPruning(true)
      const { deleted } = await api.pruneRuns(includeCompleted)
      toast(`Pruned ${deleted} run${deleted !== 1 ? 's' : ''}`, 'success')
      setPruneModalOpen(false)
      await poll()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Prune failed', 'error')
    } finally {
      setPruning(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    async function startPolling() {
      const hasActive = await poll()
      if (cancelled) return

      if (hasActive) {
        // Active runs present — poll repeatedly and stop when they finish
        intervalRef.current = setInterval(async () => {
          const stillActive = await poll()
          if (!stillActive && intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
          }
        }, POLL_MS)
      }
      // No active runs — single load only, no interval
    }

    startPolling()
    return () => {
      cancelled = true
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [])

  if (runs.length === 0) return null

  const pruneCounts = {
    failed:    runs.filter(r => r.status === 'failed').length,
    cancelled: runs.filter(r => r.status === 'cancelled').length,
    completed: runs.filter(r => r.status === 'completed').length,
  }
  const prunableCount = pruneCounts.failed + pruneCounts.cancelled + pruneCounts.completed

  return (
    <div className="border-t border-gray-100 px-3 py-3">
      <div className="mb-2 flex items-center justify-between px-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Recent Runs</p>
        {prunableCount > 0 && (
          <button
            onClick={() => setPruneModalOpen(true)}
            disabled={pruning}
            title={`Prune ${prunableCount} finished run${prunableCount !== 1 ? 's' : ''}`}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors disabled:opacity-50"
          >
            {pruning ? '…' : (
              <>
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                {prunableCount}
              </>
            )}
          </button>
        )}
      </div>
      <div className="space-y-2">
        {runs.map(run => {
          const active = isActive(run.status)
          const prog   = progress[run.id]

          // Determine what phase we're in and build label + bar values
          let phase = ''
          let bar1pct = 0   // Pass 1 bar (green when done)
          let bar2pct = 0   // Pass 2 bar (indigo)
          let label   = run.status

          if (active && prog) {
            const total = prog.total || run.total_tasks || 1
            const p1Done = prog.p1_done
            const p2Done = prog.p2_done
            const p1Running = prog.p1_running
            const p2Running = prog.p2_running

            // Count running tasks as half-done so the bar shows activity
            // even during long dedicated-mode interviews
            bar1pct = Math.round(((p1Done + p1Running * 0.5) / total) * 100)
            bar2pct = Math.round(((p2Done + p2Running * 0.5) / total) * 100)

            if (p1Done < total) {
              phase = `P1: ${p1Running > 0 ? p1Running + ' interviewing · ' : ''}${p1Done}/${total} done`
            } else {
              phase = `P2: ${p2Running > 0 ? p2Running + ' extracting · ' : ''}${p2Done}/${total} done`
            }
            label = phase
          } else if (run.status === 'completed') {
            bar1pct = 100
            bar2pct = 100
            label = `${run.total_tasks} done`
          } else if (run.status === 'failed') {
            bar1pct = run.total_tasks > 0 ? Math.round(((run.completed_tasks + run.failed_tasks) / run.total_tasks) * 100) : 0
            bar2pct = run.total_tasks > 0 ? Math.round((run.completed_tasks / run.total_tasks) * 100) : 0
            label = `${run.failed_tasks} failed`
          } else if (run.status === 'cancelled') {
            label = 'cancelled'
          } else if (active) {
            // active but no progress data yet — show spinner label
            label = 'starting…'
          }

          return (
            <Link
              key={run.id}
              href={`/runs/${run.id}`}
              className="block rounded-lg px-2 py-2 hover:bg-gray-50 transition-colors group"
            >
              {/* Row: dot · id · label */}
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`h-2 w-2 flex-shrink-0 rounded-full ${statusDot(run.status)}`} />
                <span className="font-mono text-xs text-gray-600 group-hover:text-indigo-600 transition-colors flex-1 truncate">
                  {run.id.slice(0, 8)}…
                </span>
                <span className={`text-xs font-medium flex-shrink-0 tabular-nums ${
                  run.status === 'completed' ? 'text-green-600' :
                  run.status === 'failed'    ? 'text-red-500'   :
                  run.status === 'cancelled' ? 'text-gray-400'  :
                  'text-indigo-600'
                }`}>
                  {label}
                </span>
              </div>

              {/* Two stacked progress bars: P1 (teal) on top, P2 (indigo) below */}
              {active || run.status === 'completed' || run.status === 'failed' ? (
                <div className="space-y-0.5">
                  {/* Pass 1 bar */}
                  <div className="flex items-center gap-1.5">
                    <span className="w-5 text-[10px] text-gray-400 flex-shrink-0">P1</span>
                    <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          bar1pct >= 100 ? 'bg-teal-500' : 'bg-teal-400'
                        }`}
                        style={{ width: `${active ? Math.max(bar1pct, bar1pct > 0 ? 2 : 0) : bar1pct}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-[10px] text-gray-400 flex-shrink-0 tabular-nums">
                      {bar1pct}%
                    </span>
                  </div>
                  {/* Pass 2 bar */}
                  <div className="flex items-center gap-1.5">
                    <span className="w-5 text-[10px] text-gray-400 flex-shrink-0">P2</span>
                    <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          bar2pct >= 100 ? 'bg-indigo-500' : 'bg-indigo-400'
                        }`}
                        style={{ width: `${bar2pct > 0 ? Math.max(bar2pct, 2) : 0}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-[10px] text-gray-400 flex-shrink-0 tabular-nums">
                      {bar2pct}%
                    </span>
                  </div>
                </div>
              ) : (
                /* Cancelled — simple flat bar */
                <div className="h-1 w-full rounded-full bg-gray-100" />
              )}
            </Link>
          )
        })}
      </div>

      <PruneRunsModal
        open={pruneModalOpen}
        onClose={() => setPruneModalOpen(false)}
        onConfirm={handlePruneConfirm}
        loading={pruning}
        counts={pruneCounts}
      />
    </div>
  )
}
