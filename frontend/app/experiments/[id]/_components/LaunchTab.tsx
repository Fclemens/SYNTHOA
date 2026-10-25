'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, AppSettings, Experiment, PreflightReport } from '@/lib/api'
import { fmtCost, fmtTokens, hasPricing } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/components/ui/Toast'
import { PreviewInterviewModal } from './PreviewInterviewModal'
import { ModelPicker } from '@/components/ModelPicker'
import { tokenReport } from './tokens'

interface CheckItem { ok: boolean; label: string; hint?: string; warnOnly?: boolean }

function Checklist({ items }: { items: CheckItem[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map(item => (
        <li key={item.label} className="flex items-start gap-2 text-sm">
          <span className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
            item.ok ? 'bg-green-500' : item.warnOnly ? 'bg-amber-400' : 'bg-red-500'
          }`}>
            {item.ok ? '✓' : '!'}
          </span>
          <span className={item.ok ? 'text-gray-700' : 'text-gray-900'}>
            {item.label}
            {!item.ok && item.hint && <span className="block text-xs text-gray-500">{item.hint}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ── Launch Tab ────────────────────────────────────────────────────────────────

export function LaunchTab({ experiment, onGoTo }: { experiment: Experiment; onGoTo: (tab: 'questions' | 'schema') => void }) {
  const router = useRouter()
  const { toast } = useToast()

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [panelSize, setPanelSize] = useState<number | null>(null)
  const [form, setForm] = useState({
    population_size: 10,
    model_pass1: '',
    model_pass2: '',
    dual_extraction: true,
    sample_fresh: false,
    batch_mode: false,
  })

  const [preflight, setPreflight] = useState<PreflightReport | null>(null)
  const [preflightRunning, setPreflightRunning] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [estimate, setEstimate] = useState<number | null>(null)
  const [launching, setLaunching] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    api.getSettings().then(s => {
      setSettings(s)
      setForm(f => ({ ...f, model_pass1: f.model_pass1 || s.model_pass1, model_pass2: f.model_pass2 || s.model_pass2 }))
    }).catch(() => {})
    api.getAudience(experiment.audience_id).then(a => setPanelSize(a.persona_count ?? 0)).catch(() => setPanelSize(null))
  }, [experiment.audience_id])


  const modelOptions = (_current: string) => Object.keys(settings?.model_pricing ?? {}).filter(k => k !== 'default')

  // ── Readiness ──────────────────────────────────────────────────────────────
  const nQuestions = experiment.questions?.length ?? 0
  const hasSchema = (experiment.output_schemas?.[0]?.schema_json?.length ?? 0) > 0
  const newPersonas = form.sample_fresh ? form.population_size : Math.max(0, form.population_size - (panelSize ?? 0))
  const unpriced = [form.model_pass1, form.model_pass2].filter(m => m && settings && !hasPricing(settings.model_pricing, m))
  const keyMissing = settings ? [settings.provider_pass1, settings.provider_pass2].some(p =>
    (p === 'openai' && !settings.openai_api_key_set) || (p === 'anthropic' && !settings.anthropic_api_key_set)) : false

  const batchProviders = ['openai', 'anthropic']
  const batchBlocker = experiment.execution_mode !== 'pooled' ? 'needs pooled interviews'
    : settings && !batchProviders.includes(settings.provider_pass1) ? `${settings.provider_pass1} has no batch API` : null
  const useBatch = form.batch_mode && !batchBlocker
  const costFactor = useBatch ? 0.5 : 1   // batch requests are billed at half price

  const unknownTokens = tokenReport(experiment).unknown
  const checks: CheckItem[] = [
    { ok: nQuestions > 0, label: nQuestions > 0 ? `${nQuestions} question${nQuestions !== 1 ? 's' : ''}` : 'No questions yet',
      hint: 'Add at least one question in the Questions tab.' },
    { ok: hasSchema, label: hasSchema ? 'Output schema defined' : 'No output schema',
      hint: 'Without one, runs only store raw transcripts and the analysis has nothing to chart.', warnOnly: true },
    { ok: newPersonas === 0, warnOnly: true,
      label: newPersonas === 0 ? `Using ${form.population_size} of ${panelSize ?? '?'} existing personas` : `${newPersonas} new persona${newPersonas !== 1 ? 's' : ''} will be sampled`,
      hint: 'New personas get LLM-written backstories at launch, which adds cost and time.' },
    { ok: unpriced.length === 0, warnOnly: true, label: unpriced.length === 0 ? 'Pricing known for both models' : `No pricing for ${unpriced.join(', ')}`,
      hint: 'Costs for these models will show as $0. Add their prices in Settings → Token Pricing.' },
    { ok: !keyMissing, label: keyMissing ? 'API key missing' : 'API keys configured',
      hint: 'Add the key for the selected provider in Settings.' },
    ...(unknownTokens.length ? [{
      ok: false, warnOnly: true,
      label: `Undefined variable${unknownTokens.length > 1 ? 's' : ''}: ${Array.from(new Set(unknownTokens.map(u => `{${u.token}}`))).join(', ')}`,
      hint: 'These would reach the model as literal text. Define them in the Variables tab or fix the spelling.',
    }] : []),
  ]
  const blocked = nQuestions === 0 || keyMissing

  // ── Actions ────────────────────────────────────────────────────────────────
  async function runPreflight(sampleSize: number): Promise<PreflightReport | null> {
    return api.preflight(experiment.id, {
      sample_size: sampleSize,
      model_pass1: form.model_pass1 || undefined,
      model_pass2: form.model_pass2 || undefined,
      dual_extraction: form.dual_extraction,
    })
  }

  async function handlePreflight() {
    try {
      setPreflightRunning(true)
      setPreflight(await runPreflight(Math.min(form.population_size, panelSize ?? form.population_size)))
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Preflight failed', 'error')
    } finally {
      setPreflightRunning(false)
    }
  }

  async function openConfirm() {
    setEstimate(null)
    setConfirmOpen(true)
    if (!panelSize) return   // no personas to estimate from yet
    try {
      const report = await runPreflight(Math.min(5, panelSize))
      setEstimate(report ? report.cost_estimate.per_persona * form.population_size * costFactor : null)
    } catch { /* estimate stays unknown */ }
  }

  async function handleLaunch() {
    try {
      setLaunching(true)
      const run = await api.launchRun(experiment.id, {
        population_size: form.population_size,
        model_pass1: form.model_pass1 || undefined,
        model_pass2: form.model_pass2 || undefined,
        dual_extraction: form.dual_extraction,
        sample_fresh: form.sample_fresh,
        batch_mode: useBatch,
      })
      toast('Simulation launched', 'success')
      router.push(`/runs/${run.id}`)
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Launch failed', 'error')
      setLaunching(false)
      setConfirmOpen(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Readiness */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">Ready to launch?</h2>
            <div className="flex gap-2">
              {nQuestions === 0 && <Button size="sm" variant="outline" onClick={() => onGoTo('questions')}>Add questions</Button>}
              {nQuestions > 0 && !hasSchema && <Button size="sm" variant="outline" onClick={() => onGoTo('schema')}>Define schema</Button>}
            </div>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <Checklist items={checks} />
          <div className="flex items-center justify-between rounded-lg bg-indigo-50 px-4 py-3">
            <div className="text-sm text-indigo-900">
              <p className="font-medium">Test with one persona first</p>
              <p className="text-xs text-indigo-700">Runs a single real interview and extraction so you can check the prompt and answers before paying for a full run.</p>
            </div>
            <Button size="sm" variant="outline" disabled={nQuestions === 0 || !panelSize} onClick={() => setPreviewOpen(true)}>
              Test with 1 persona
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* Launch Configuration */}
      <Card>
        <CardHeader>
          <h2 className="font-semibold text-gray-800">Launch Configuration</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700">Population Size</label>
              <input
                type="number"
                min={1}
                value={form.population_size}
                onChange={e => setForm(f => ({ ...f, population_size: Math.max(1, parseInt(e.target.value) || 1) }))}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              {panelSize !== null && <p className="mt-0.5 text-xs text-gray-400">Audience panel: {panelSize} personas</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700">Model Pass 1 (interview)</label>
              <ModelPicker value={form.model_pass1} onChange={v => setForm(f => ({ ...f, model_pass1: v }))} options={modelOptions(form.model_pass1)} />
              <p className="mt-0.5 text-xs text-gray-400">Default: {settings?.model_pass1 ?? '…'} · {settings?.provider_pass1}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Model Pass 2 (extraction)</label>
              <ModelPicker value={form.model_pass2} onChange={v => setForm(f => ({ ...f, model_pass2: v }))} options={modelOptions(form.model_pass2)} />
              <p className="mt-0.5 text-xs text-gray-400">Default: {settings?.model_pass2 ?? '…'} · {settings?.provider_pass2}</p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.dual_extraction}
                onChange={e => setForm(f => ({ ...f, dual_extraction: e.target.checked }))}
                className="rounded border-gray-300 text-indigo-600"
              />
              <span className="font-medium text-gray-700">Dual extraction</span>
              <span className="text-xs text-gray-400">(extracts twice and flags disagreements; doubles Pass 2 cost)</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.sample_fresh}
                onChange={e => setForm(f => ({ ...f, sample_fresh: e.target.checked }))}
                className="rounded border-gray-300 text-indigo-600"
              />
              <span className="font-medium text-gray-700">Sample fresh personas</span>
              <span className="text-xs text-gray-400">(unchecked = reuse existing audience personas)</span>
            </label>
            <label className={`flex items-center gap-2 text-sm ${batchBlocker ? 'opacity-50' : ''}`}>
              <input
                type="checkbox"
                checked={useBatch}
                disabled={!!batchBlocker}
                onChange={e => setForm(f => ({ ...f, batch_mode: e.target.checked }))}
                className="rounded border-gray-300 text-indigo-600"
              />
              <span className="font-medium text-gray-700">Batch mode</span>
              <span className="text-xs text-gray-400">
                {batchBlocker ? `(unavailable: ${batchBlocker})` : '(half price; results within 24h, usually much sooner)'}
              </span>
            </label>
          </div>
        </CardBody>
      </Card>

      {/* Preflight */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">Cost Estimate</h2>
            <Button size="sm" variant="outline" loading={preflightRunning} disabled={!panelSize} onClick={handlePreflight}>
              Estimate cost
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          {preflight ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-lg bg-indigo-50 p-3 text-center">
                <p className="text-xs text-indigo-500 mb-1">Est. total for {form.population_size}{useBatch ? ' (batch)' : ''}</p>
                <p className="font-semibold text-indigo-700">{fmtCost(preflight.cost_estimate.per_persona * form.population_size * costFactor)}</p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">Per Persona</p>
                <p className="font-semibold text-gray-700">{fmtCost(preflight.cost_estimate.per_persona * costFactor)}</p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">P1 Tokens / persona</p>
                <p className="font-semibold text-gray-700">{fmtTokens(preflight.token_estimate.pass1_input_tokens + preflight.token_estimate.pass1_output_tokens)}</p>
              </div>
              <div className="rounded-lg bg-gray-50 p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">Sampled for estimate</p>
                <p className="font-semibold text-gray-700">{preflight.sample_size}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              {panelSize ? 'Estimate token cost from a sample of your personas — no LLM calls are made.'
                : 'Sample personas in the audience first to get a cost estimate.'}
            </p>
          )}
        </CardBody>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {blocked && <span className="text-sm text-gray-500">Fix the items marked red above to launch.</span>}
        <Button size="lg" disabled={blocked} onClick={openConfirm}>
          Launch Simulation
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Launch simulation?"
        confirmLabel={`Launch ${form.population_size} interview${form.population_size !== 1 ? 's' : ''}`}
        loading={launching}
        onConfirm={handleLaunch}
        onClose={() => setConfirmOpen(false)}
      >
        <div className="space-y-2">
          <p>
            <strong>{form.population_size}</strong> personas · <span className="font-mono">{form.model_pass1}</span> interviews ·{' '}
            <span className="font-mono">{form.model_pass2}</span> extraction{form.dual_extraction ? ' (dual)' : ''}
          </p>
          {useBatch && (
            <p className="text-xs text-gray-500">
              Batch mode: one persona runs live to check the setup, the rest are submitted to the provider&apos;s batch API.
              Results can take up to 24 hours; you can close SYNTHOA meanwhile.
            </p>
          )}
          <p>
            Estimated cost:{' '}
            <strong>
              {estimate !== null ? `≈ ${fmtCost(estimate)}` : panelSize ? 'estimating…' : 'unknown until the audience has personas'}
            </strong>
            {unpriced.length > 0 && <span className="block text-xs text-amber-700">Excludes {unpriced.join(', ')} (no pricing set).</span>}
          </p>
          {newPersonas > 0 && (
            <p className="text-xs text-gray-500">
              Includes sampling {newPersonas} new persona{newPersonas !== 1 ? 's' : ''}; their backstories are written by the LLM and are not in the estimate.
            </p>
          )}
        </div>
      </ConfirmDialog>

      <PreviewInterviewModal
        open={previewOpen}
        experimentId={experiment.id}
        model={form.model_pass1}
        onClose={() => setPreviewOpen(false)}
      />
    </div>
  )
}
