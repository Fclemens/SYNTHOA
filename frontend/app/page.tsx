'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, Audience, Experiment, hasResults, isRunActive, SimulationRun } from '@/lib/api'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { PageSpinner } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/Toast'
import { fmtCost, fmtDateTime, pct, runDetails, runLabel, runStatusColor, runStatusLabel } from '@/lib/utils'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { PruneRunsModal } from '@/components/PruneRunsModal'

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-[10px] border border-gray-100 bg-white/[0.025] px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.06em] text-gray-500">{label}</p>
      <p className="mt-0.5 font-mono text-[22px] font-medium text-gray-900">{value}</p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </div>
  )
}

function Step({ done, n, title, hint, href, cta }: { done: boolean; n: number; title: string; hint: string; href: string; cta: string }) {
  return (
    <div className={`flex items-center gap-4 rounded-[10px] border px-4 py-3 ${done ? 'border-gray-100' : 'border-indigo-300 bg-indigo-50'}`}>
      <span className={`grid h-7 w-7 flex-none place-items-center rounded-full text-xs font-semibold ${done ? 'bg-green-100 text-green-700' : 'bg-accent text-white'}`}>
        {done ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${done ? 'text-gray-500 line-through' : 'text-gray-900'}`}>{title}</p>
        <p className="text-xs text-gray-500">{hint}</p>
      </div>
      {!done && <Link href={href}><Button size="sm">{cta}</Button></Link>}
    </div>
  )
}

export default function Dashboard() {
  const { toast } = useToast()
  const [audiences, setAudiences] = useState<Audience[]>([])
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [runs, setRuns] = useState<SimulationRun[]>([])
  const [loading, setLoading] = useState(true)
  const [pruneModalOpen, setPruneModalOpen] = useState(false)
  const [pruning, setPruning] = useState(false)

  async function loadAll() {
    const [a, e, r] = await Promise.all([api.listAudiences(), api.listExperiments(), api.listRuns(undefined, 200)])
    setAudiences(a)
    setExperiments(e)
    setRuns(r)
  }

  useEffect(() => {
    loadAll()
      .catch((e: unknown) => toast(e instanceof Error ? e.message : 'Failed to load dashboard', 'error'))
      .finally(() => setLoading(false))
  }, [])

  async function handlePruneConfirm(includeCompleted: boolean) {
    try {
      setPruning(true)
      const { deleted } = await api.pruneRuns(includeCompleted)
      toast(`Pruned ${deleted} run${deleted !== 1 ? 's' : ''}`, 'success')
      setPruneModalOpen(false)
      await loadAll()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Prune failed', 'error')
    } finally {
      setPruning(false)
    }
  }

  if (loading) return <PageSpinner />

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  const monthRuns = runs.filter(r => new Date(r.created_at) >= monthStart)
  const spend = monthRuns.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0)
  const personas = audiences.reduce((s, a) => s + (a.persona_count ?? 0), 0)
  const activeRuns = runs.filter(r => isRunActive(r.status))
  const lastRun = runs[0]
  const lastExperiment = lastRun ? experiments.find(e => e.id === lastRun.experiment_id) : experiments[0]
  const pruneCounts = {
    failed: runs.filter(r => r.status === 'failed').length,
    cancelled: runs.filter(r => r.status === 'cancelled').length,
    completed: runs.filter(r => hasResults(r.status)).length,
  }
  const hasPrunable = pruneCounts.failed + pruneCounts.cancelled + pruneCounts.completed > 0
  const onboarding = runs.length === 0

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">Synthetic customer research, end to end</p>
        </div>
        <div className="flex gap-2">
          <Link href="/audiences"><Button variant="secondary">+ Audience</Button></Link>
          <Link href="/experiments"><Button>+ Experiment</Button></Link>
        </div>
      </div>

      {onboarding ? (
        <Card>
          <CardBody className="space-y-3">
            <div>
              <h2 className="font-semibold text-gray-900">Get started</h2>
              <p className="text-sm text-gray-500">Four steps from an empty workspace to your first results.</p>
            </div>
            <Step n={1} done={audiences.length > 0} title="Create an audience" hint="Describe your population with variables like age, income or region." href="/audiences" cta="Create" />
            <Step n={2} done={personas > 0} title="Sample personas" hint="Generate a panel of synthetic respondents from the audience." href={audiences[0] ? `/audiences/${audiences[0].id}` : '/audiences'} cta="Sample" />
            <Step n={3} done={experiments.length > 0} title="Design an experiment" hint="Write the questions and choose what to extract from each interview." href="/experiments" cta="Create" />
            <Step n={4} done={false} title="Test and launch" hint="Try one persona, check the cost, then run the full panel." href={experiments[0] ? `/experiments/${experiments[0].id}?tab=launch` : '/experiments'} cta="Launch" />
          </CardBody>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {lastRun && (
            <Card>
              <CardBody>
                <p className="text-[11px] uppercase tracking-[0.06em] text-gray-500">Latest run</p>
                <div className="mt-1 flex items-center gap-2">
                  <p className="truncate text-base font-semibold text-gray-900">{lastRun.experiment_name} · {runLabel(lastRun)}</p>
                  <Badge color={runStatusColor(lastRun.status)}>{runStatusLabel(lastRun.status)}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-gray-500">{runDetails(lastRun)} · {fmtDateTime(lastRun.created_at)}</p>
                <div className="mt-3">
                  <ProgressBar value={pct(lastRun.completed_tasks, lastRun.total_tasks)} size="sm" showLabel />
                </div>
                <div className="mt-4 flex gap-2">
                  {hasResults(lastRun.status)
                    ? <Link href={`/analysis/${lastRun.id}`}><Button size="sm">View results</Button></Link>
                    : <Link href={`/runs/${lastRun.id}`}><Button size="sm">Open run</Button></Link>}
                  <Link href={`/runs/${lastRun.id}`}><Button size="sm" variant="ghost">Run details</Button></Link>
                </div>
              </CardBody>
            </Card>
          )}
          {lastExperiment && (
            <Card>
              <CardBody>
                <p className="text-[11px] uppercase tracking-[0.06em] text-gray-500">Continue where you left off</p>
                <p className="mt-1 truncate text-base font-semibold text-gray-900">{lastExperiment.name}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {lastExperiment.questions.length} question{lastExperiment.questions.length !== 1 ? 's' : ''} · {lastExperiment.dist_variables.length} variable{lastExperiment.dist_variables.length !== 1 ? 's' : ''} ·{' '}
                  {runs.filter(r => r.experiment_id === lastExperiment.id).length} runs
                </p>
                <div className="mt-4 flex gap-2">
                  <Link href={`/experiments/${lastExperiment.id}`}><Button size="sm" variant="secondary">Open experiment</Button></Link>
                  <Link href={`/experiments/${lastExperiment.id}?tab=launch`}><Button size="sm" variant="ghost">New run</Button></Link>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Audiences" value={audiences.length} sub={`${personas} personas`} />
        <Stat label="Experiments" value={experiments.length} />
        <Stat label="Runs this month" value={monthRuns.length} sub={activeRuns.length ? `${activeRuns.length} running now` : 'none running'} />
        <Stat label="Spend this month" value={fmtCost(spend)} sub="LLM cost of runs" />
      </div>

      {runs.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Recent runs</h2>
            {hasPrunable && <Button size="sm" variant="ghost" onClick={() => setPruneModalOpen(true)}>Clean up runs…</Button>}
          </div>
          <Card>
            <div className="divide-y divide-gray-100">
              {runs.slice(0, 6).map(run => (
                <Link key={run.id} href={hasResults(run.status) ? `/analysis/${run.id}` : `/runs/${run.id}`}
                  className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-gray-50">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium text-gray-900">{run.experiment_name} · {runLabel(run)}</p>
                      <Badge color={runStatusColor(run.status)}>{runStatusLabel(run.status)}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500">{runDetails(run)}</p>
                  </div>
                  <div className="w-40 shrink-0">
                    <ProgressBar value={pct(run.completed_tasks, run.total_tasks)} size="sm" />
                  </div>
                  <div className="w-36 shrink-0 text-right">
                    <p className="font-mono text-sm text-gray-800">{fmtCost(run.total_cost_usd)}</p>
                    <p className="text-xs text-gray-500">{fmtDateTime(run.created_at)}</p>
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        </div>
      )}

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
