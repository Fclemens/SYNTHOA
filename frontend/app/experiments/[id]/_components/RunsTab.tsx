'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api, Experiment, hasResults, isRunActive, SimulationRun } from '@/lib/api'
import { usePolling } from '@/lib/usePolling'
import { fmtCost, fmtDateTime, pct, runDetails, runLabel, runStatusColor, runStatusLabel } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { OverflowMenu } from '@/components/ui/OverflowMenu'
import { ProgressBar } from '@/components/ui/ProgressBar'

/** Every run of this experiment, newest first, with a path to its results and a quick compare. */
export function RunsTab({ experiment, onNewRun, onCount }: {
  experiment: Experiment; onNewRun: () => void; onCount?: (n: number) => void
}) {
  const router = useRouter()
  const [runs, setRuns] = useState<SimulationRun[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])

  usePolling(async () => {
    const data = await api.listRuns(experiment.id, 200)
    setRuns(data)
    onCount?.(data.length)
    return data.some(r => isRunActive(r.status))
  }, { intervalMs: 3000, immediate: true }, experiment.id)

  if (runs === null) return null

  if (runs.length === 0) {
    return (
      <Card>
        <CardBody className="py-10 text-center">
          <p className="font-medium text-gray-900">No runs yet</p>
          <p className="mt-1 text-sm text-gray-500">Launch the experiment to interview your personas.</p>
          <Button className="mt-4" onClick={onNewRun}>Go to Launch</Button>
        </CardBody>
      </Card>
    )
  }

  const toggle = (id: string) =>
    setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : p.length < 2 ? [...p, id] : [p[1], id]))
  const comparable = runs.filter(r => hasResults(r.status))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {runs.length} run{runs.length !== 1 ? 's' : ''}
          {comparable.length >= 2 && ' · tick two finished runs to compare them'}
        </p>
        {picked.length === 2 && (
          <Link href={`/analysis/compare?a=${picked[0]}&b=${picked[1]}`}><Button size="sm" variant="secondary">Compare selected</Button></Link>
        )}
      </div>
      <Card>
        <div className="divide-y divide-gray-100">
          {runs.map(run => {
            const done = hasResults(run.status)
            return (
              <div key={run.id} className="flex items-center gap-4 px-5 py-3.5">
                <input
                  type="checkbox"
                  aria-label={`Select ${runLabel(run)} for comparison`}
                  disabled={!done}
                  checked={picked.includes(run.id)}
                  onChange={() => toggle(run.id)}
                  className={comparable.length >= 2 ? '' : 'invisible'}
                />
                <Link href={done ? `/analysis/${run.id}` : `/runs/${run.id}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 hover:text-indigo-700">{runLabel(run)}</span>
                    {run.name && run.run_number && <span className="text-xs text-gray-500">#{run.run_number}</span>}
                    <Badge color={runStatusColor(run.status)}>{runStatusLabel(run.status)}</Badge>
                    {run.failed_tasks > 0 && <Badge color="red">{run.failed_tasks} failed</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">{runDetails(run)} · {fmtCost(run.total_cost_usd)} · {fmtDateTime(run.created_at)}</p>
                  {isRunActive(run.status) && (
                    <div className="mt-2 max-w-sm"><ProgressBar value={pct(run.completed_tasks, run.total_tasks)} size="sm" /></div>
                  )}
                </Link>
                <div className="flex shrink-0 items-center gap-1">
                  {done && <Link href={`/analysis/${run.id}`}><Button size="sm" variant="secondary">Results</Button></Link>}
                  <OverflowMenu items={[
                    { label: 'Run details', onClick: () => router.push(`/runs/${run.id}`) },
                    { label: 'Export CSV', onClick: () => window.open(api.exportRun(run.id, 'csv'), '_blank'), disabled: run.completed_tasks === 0 },
                    { label: 'Export Excel', onClick: () => window.open(api.exportRun(run.id, 'xlsx'), '_blank'), disabled: run.completed_tasks === 0 },
                  ]} />
                </div>
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}
