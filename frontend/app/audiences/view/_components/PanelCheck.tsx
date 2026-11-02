'use client'
import { useEffect, useState } from 'react'
import { api, PanelCheck as PanelCheckData, PanelCheckVariable } from '@/lib/api'
import { Card, CardBody } from '@/components/ui/Card'
import { Spinner } from '@/components/ui/Spinner'

const pct = (x: number) => `${Math.round(x * 100)}%`

/** Quality label from the largest gap between target and sampled shares. */
function fit(gap: number, n: number): { label: string; cls: string } {
  // With small panels some noise is expected: allow ~2 standard errors of a proportion.
  const tolerance = Math.max(0.05, 2 * Math.sqrt(0.25 / Math.max(n, 1)))
  if (gap <= tolerance) return { label: 'matches', cls: 'text-green-700' }
  if (gap <= tolerance * 2) return { label: 'close', cls: 'text-amber-700' }
  return { label: 'off target', cls: 'text-red-700' }
}

function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-gray-500">
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border border-gray-400" /> target</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-indigo-500" /> sampled</span>
    </div>
  )
}

function CategoricalChart({ v, n }: { v: PanelCheckVariable; n: number }) {
  const cats = v.categories ?? []
  const max = Math.max(...cats.flatMap(c => [c.target, c.actual]), 0.01)
  const f = fit(v.max_gap ?? 0, n)
  return (
    <>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="font-medium text-gray-900">{v.name}</p>
        <span className={`text-xs ${v.has_rules ? 'text-gray-500' : f.cls}`}>{v.has_rules ? 'adjusted by rules' : f.label}</span>
      </div>
      <div className="space-y-1.5">
        {cats.map(c => (
          <div key={c.label} className="grid grid-cols-[minmax(0,7rem)_1fr_4.5rem] items-center gap-2 text-xs">
            <span className="truncate text-gray-700" title={c.label}>{c.label}</span>
            <div className="relative h-3.5 rounded bg-white/[0.04]">
              <div className="absolute inset-y-0 left-0 rounded bg-indigo-500/80" style={{ width: `${(c.actual / max) * 100}%` }} />
              <div className="absolute inset-y-0 border-r-2 border-gray-700" style={{ left: `${(c.target / max) * 100}%` }} title={`target ${pct(c.target)}`} />
            </div>
            <span className="text-right font-mono text-gray-600">{pct(c.actual)} <span className="text-gray-400">/ {pct(c.target)}</span></span>
          </div>
        ))}
      </div>
    </>
  )
}

function NumericChart({ v }: { v: PanelCheckVariable }) {
  const bins = v.bins ?? []
  const max = Math.max(...bins.flatMap(b => [b.target, b.actual]), 0.01)
  const fmt = (x: number | null | undefined) => (x === null || x === undefined ? '—' : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : String(+x.toFixed(2)))
  return (
    <>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="font-medium text-gray-900">{v.name}</p>
        <span className="font-mono text-xs text-gray-500">mean {fmt(v.actual_mean)} <span className="text-gray-400">/ {fmt(v.target_mean)}</span></span>
      </div>
      <div className="flex h-20 items-end gap-[3px]">
        {bins.map((b, i) => (
          <div key={i} className="relative flex h-full flex-1 items-end" title={`${fmt(b.lo)}–${fmt(b.hi)}: ${pct(b.actual)} sampled, ${pct(b.target)} target`}>
            <div className="w-full rounded-t bg-indigo-500/80" style={{ height: `${(b.actual / max) * 100}%` }} />
            <div className="absolute inset-x-0 border-t-2 border-gray-700" style={{ bottom: `${(b.target / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-gray-500">
        <span>{fmt(bins[0]?.lo)}</span><span>{fmt(bins[bins.length - 1]?.hi)}</span>
      </div>
    </>
  )
}

/** Does the sampled panel look like the audience definition? */
export function PanelCheck({ audienceId, refreshKey }: { audienceId: string; refreshKey: unknown }) {
  const [data, setData] = useState<PanelCheckData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    api.panelCheck(audienceId).then(setData).catch(e => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [audienceId, refreshKey])

  if (error) return <p className="text-sm text-red-700">{error}</p>
  if (!data) return <div className="flex justify-center py-8"><Spinner /></div>
  if (data.n_personas === 0) return <p className="text-sm text-gray-500">Sample some personas to compare them with the definition.</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {data.n_personas} personas compared with the distributions you defined.
          {data.n_personas < 100 && ' Small panels vary more — differences of a few points are normal.'}
        </p>
        <Legend />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {data.variables.map(v => (
          <Card key={v.id}>
            <CardBody>{v.kind === 'numeric' ? <NumericChart v={v} /> : <CategoricalChart v={v} n={data.n_personas} />}</CardBody>
          </Card>
        ))}
      </div>
      {data.correlations.length > 0 && (
        <Card>
          <CardBody>
            <p className="mb-2 font-medium text-gray-900">Correlations</p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500">
                  <th className="py-1 text-left font-medium">Pair</th>
                  <th className="py-1 text-right font-medium">Target</th>
                  <th className="py-1 text-right font-medium">Sampled</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.correlations.map(c => {
                  const gap = c.actual === null ? null : Math.abs(c.actual - c.target)
                  return (
                    <tr key={`${c.var_a}-${c.var_b}`}>
                      <td className="py-1.5 text-gray-800">{c.var_a} × {c.var_b}</td>
                      <td className="py-1.5 text-right font-mono text-gray-600">{c.target.toFixed(2)}</td>
                      <td className={`py-1.5 text-right font-mono ${gap === null ? 'text-gray-500' : gap <= 0.1 ? 'text-green-700' : gap <= 0.2 ? 'text-amber-700' : 'text-red-700'}`}>
                        {c.actual === null ? '—' : c.actual.toFixed(2)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-gray-500">Pearson correlation on the sampled values (ordered labels use their rank).</p>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
