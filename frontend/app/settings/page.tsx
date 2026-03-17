'use client'
import { useEffect, useState } from 'react'
import { api, AppSettings, ModelPricing } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { PageSpinner } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/Toast'

// ── Constants ─────────────────────────────────────────────────────────────────

const PROVIDER_OPTIONS = [
  { value: 'openai',    label: 'OpenAI' },
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'anthropic', label: 'Anthropic' },
]

interface StepMeta {
  label: string
  description: string
  providerKey: keyof AppSettings
  modelKey: keyof AppSettings
  effectiveProviderKey?: keyof AppSettings
  effectiveModelKey?: keyof AppSettings
}

const STEPS: StepMeta[] = [
  {
    label: 'Pass 1 — Interview',
    description: 'Simulated respondent interview. Receives the persona backstory + survey questions and produces the raw transcript.',
    providerKey: 'provider_pass1',
    modelKey: 'model_pass1',
  },
  {
    label: 'Pass 2 — Extraction',
    description: 'Extracts structured answers from the transcript (dual-extraction at temp 0 and 0.3). Also used as fallback for backstory and validation when those are left blank.',
    providerKey: 'provider_pass2',
    modelKey: 'model_pass2',
  },
  {
    label: 'Backstory Generation',
    description: 'Generates the 150–250 word first-person system prompt from sampled persona traits. Leave blank to inherit Pass 2 settings.',
    providerKey: 'provider_backstory',
    modelKey: 'model_backstory',
    effectiveProviderKey: 'effective_backstory_provider',
    effectiveModelKey: 'effective_backstory_model',
  },
  {
    label: 'LLM Plausibility Validation',
    description: 'Optional LLM-based plausibility check on sampled traits. Leave blank to inherit Pass 2 settings.',
    providerKey: 'provider_validation',
    modelKey: 'model_validation',
    effectiveProviderKey: 'effective_validation_provider',
    effectiveModelKey: 'effective_validation_model',
  },
]

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { toast } = useToast()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Form state — write-only key fields start empty (never pre-filled)
  const [form, setForm] = useState<Record<string, unknown>>({})

  async function load() {
    try {
      setLoading(true)
      const s = await api.getSettings()
      setSettings(s)
      setForm({
        provider_pass1: s.provider_pass1,
        model_pass1: s.model_pass1,
        provider_pass2: s.provider_pass2,
        model_pass2: s.model_pass2,
        provider_backstory: s.provider_backstory,
        model_backstory: s.model_backstory,
        provider_validation: s.provider_validation,
        model_validation: s.model_validation,
        lmstudio_base_url: s.lmstudio_base_url,
        openai_api_key: '',       // write-only — never pre-filled
        anthropic_api_key: '',    // write-only — never pre-filled
        max_concurrent_tasks: s.max_concurrent_tasks,
        tpm_limit: s.tpm_limit,
        plausibility_threshold: s.plausibility_threshold,
        max_context_tokens: s.max_context_tokens,
        model_pricing: { ...s.model_pricing },
      })
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to load settings', 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    try {
      setSaving(true)
      // Only send API keys if the user actually typed something
      const patch: Record<string, unknown> = { ...form }
      if (!patch.openai_api_key) delete patch.openai_api_key
      if (!patch.anthropic_api_key) delete patch.anthropic_api_key
      const updated = await api.updateSettings(patch)
      setSettings(updated)
      // Clear key fields after successful save
      setForm(f => ({ ...f, openai_api_key: '', anthropic_api_key: '' }))
      toast('Settings saved', 'success')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to save settings', 'error')
    } finally {
      setSaving(false)
    }
  }

  const set = (key: string, value: unknown) =>
    setForm(f => ({ ...f, [key]: value }))

  const inputCls = 'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500'
  const selectCls = 'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white'
  const labelCls = 'block text-sm font-medium text-gray-700'
  const helpCls = 'mt-1 text-xs text-gray-400'

  if (loading) return <PageSpinner />

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure providers and models per pipeline step. Changes persist to{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">settings_override.json</code>{' '}
          and take effect immediately without restart.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">

        {/* ── 1. Pipeline Steps ─────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-gray-800">Pipeline Steps</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              Each step can use a different provider and model.
            </p>
          </CardHeader>
          <CardBody className="divide-y divide-gray-100">
            {STEPS.map(step => {
              const providerVal = (form[step.providerKey as string] as string) ?? 'openai'
              const modelVal    = (form[step.modelKey as string] as string) ?? ''
              const hasInherit  = !!step.effectiveProviderKey
              const effProvider = step.effectiveProviderKey ? (settings?.[step.effectiveProviderKey] as string) : null
              const effModel    = step.effectiveModelKey    ? (settings?.[step.effectiveModelKey]    as string) : null
              const isInheriting = hasInherit && (!providerVal || providerVal === '') && (!modelVal || modelVal === '')

              return (
                <div key={step.label} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="text-sm font-medium text-gray-800">{step.label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{step.description}</p>
                    </div>
                    {isInheriting && effProvider && (
                      <span className="ml-3 shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600">
                        inherits pass 2
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Provider</label>
                      <select
                        value={providerVal}
                        onChange={e => set(step.providerKey as string, e.target.value)}
                        className={selectCls}
                      >
                        {hasInherit && (
                          <option value="">— inherit from Pass 2 —</option>
                        )}
                        {PROVIDER_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Model</label>
                      <input
                        type="text"
                        value={modelVal}
                        onChange={e => set(step.modelKey as string, e.target.value)}
                        className={inputCls}
                        placeholder={hasInherit ? 'leave blank to inherit' : 'e.g. gpt-4o'}
                      />
                    </div>
                  </div>
                  {hasInherit && effProvider && effModel && (
                    <p className="mt-1.5 text-xs text-indigo-500">
                      Effective: <span className="font-mono font-medium">{effProvider}</span>{' / '}
                      <span className="font-mono font-medium">{effModel}</span>
                    </p>
                  )}
                </div>
              )
            })}
          </CardBody>
        </Card>

        {/* ── 2. Execution & Quality ────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-gray-800">Execution &amp; Quality</h2>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Max concurrent tasks</label>
                <input type="number" min={1} max={100}
                  value={(form.max_concurrent_tasks as number) ?? 10}
                  onChange={e => set('max_concurrent_tasks', parseInt(e.target.value) || 10)}
                  className={inputCls} />
                <p className={helpCls}>Parallel asyncio tasks. Lower for local models.</p>
              </div>
              <div>
                <label className={labelCls}>TPM limit</label>
                <input type="number" min={1000}
                  value={(form.tpm_limit as number) ?? 2000000}
                  onChange={e => set('tpm_limit', parseInt(e.target.value) || 2000000)}
                  className={inputCls} />
                <p className={helpCls}>Tokens-per-minute rate limit (set to 999999999 for local).</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Plausibility threshold</label>
                <input type="number" min={0} max={1} step={0.05}
                  value={(form.plausibility_threshold as number) ?? 0.5}
                  onChange={e => set('plausibility_threshold', parseFloat(e.target.value) || 0.5)}
                  className={inputCls} />
                <p className={helpCls}>Personas scoring below this are flagged (0–1).</p>
              </div>
              <div>
                <label className={labelCls}>Max context tokens</label>
                <input type="number" min={1000}
                  value={(form.max_context_tokens as number) ?? 100000}
                  onChange={e => set('max_context_tokens', parseInt(e.target.value) || 100000)}
                  className={inputCls} />
                <p className={helpCls}>
                  Must match model context window. Common: 8 192, 32 768, 128 000.
                </p>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* ── 3. Token Pricing ──────────────────────────────────────────── */}
        <PricingCard
          pricing={(form.model_pricing as Record<string, ModelPricing>) ?? {}}
          onChange={p => set('model_pricing', p)}
        />

        {/* ── 4. API Keys & Endpoints ───────────────────────────────────── */}
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-gray-800">API Keys &amp; Endpoints</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              Keys are stored in <code className="rounded bg-gray-100 px-1 text-xs">settings_override.json</code> and never echoed back.
              Leave a key field blank to keep the existing value.
            </p>
          </CardHeader>
          <CardBody className="space-y-4">

            {/* OpenAI */}
            <div>
              <label className={labelCls}>OpenAI API Key</label>
              <input
                type="password"
                value={(form.openai_api_key as string) ?? ''}
                onChange={e => set('openai_api_key', e.target.value)}
                className={inputCls}
                placeholder={settings?.openai_api_key_set ? '●●●●●●●● (set — leave blank to keep)' : 'sk-…'}
                autoComplete="off"
              />
              <p className={helpCls}>
                Used when provider = <strong>OpenAI</strong>.
              </p>
            </div>

            {/* LM Studio */}
            <div>
              <label className={labelCls}>LM Studio / Ollama Base URL</label>
              <input
                type="text"
                value={(form.lmstudio_base_url as string) ?? ''}
                onChange={e => set('lmstudio_base_url', e.target.value)}
                className={inputCls}
                placeholder="http://127.0.0.1:1234/v1"
              />
              <p className={helpCls}>
                Used when provider = <strong>LM Studio</strong>. Also compatible with Ollama and vLLM.
              </p>
            </div>

            {/* Anthropic */}
            <div>
              <label className={labelCls}>Anthropic API Key</label>
              <input
                type="password"
                value={(form.anthropic_api_key as string) ?? ''}
                onChange={e => set('anthropic_api_key', e.target.value)}
                className={inputCls}
                placeholder={settings?.anthropic_api_key_set ? '●●●●●●●● (set — leave blank to keep)' : 'sk-ant-…'}
                autoComplete="off"
              />
              <p className={helpCls}>
                Used when provider = <strong>Anthropic</strong>.
                Models: <code className="rounded bg-gray-100 px-1 text-xs">claude-opus-4-5</code>,{' '}
                <code className="rounded bg-gray-100 px-1 text-xs">claude-sonnet-4-5</code>,{' '}
                <code className="rounded bg-gray-100 px-1 text-xs">claude-haiku-3-5</code>.
              </p>
            </div>

          </CardBody>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" loading={saving}>Save Settings</Button>
        </div>
      </form>
    </div>
  )
}

// ── Pricing sub-component ─────────────────────────────────────────────────────

function PricingCard({
  pricing,
  onChange,
}: {
  pricing: Record<string, ModelPricing>
  onChange: (p: Record<string, ModelPricing>) => void
}) {
  const [newModel, setNewModel] = useState('')

  const models = Object.keys(pricing)

  function update(model: string, field: 'input' | 'output', raw: string) {
    const val = parseFloat(raw)
    if (isNaN(val) || val < 0) return
    onChange({ ...pricing, [model]: { ...pricing[model], [field]: val } })
  }

  function addModel() {
    const key = newModel.trim()
    if (!key || pricing[key]) return
    onChange({ ...pricing, [key]: { input: 0, output: 0 } })
    setNewModel('')
  }

  function removeModel(model: string) {
    if (model === 'default') return
    const next = { ...pricing }
    delete next[model]
    onChange(next)
  }

  const cellCls = 'px-3 py-2 text-sm'
  const numInputCls = 'w-24 rounded border border-gray-300 px-2 py-1 text-sm font-mono focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500'

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-gray-800">Token Pricing</h2>
        <p className="mt-0.5 text-xs text-gray-400">
          USD per 1 million tokens. &ldquo;default&rdquo; is the fallback for unlisted models — set to 0 for local/Ollama.
        </p>
      </CardHeader>
      <CardBody className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left">
                <th className="px-3 py-2 font-medium text-gray-600">Model</th>
                <th className="px-3 py-2 font-medium text-gray-600">Input ($/1M)</th>
                <th className="px-3 py-2 font-medium text-gray-600">Output ($/1M)</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {models.map(model => (
                <tr key={model}>
                  <td className={cellCls}>
                    <span className="font-mono text-gray-700">{model}</span>
                    {model === 'default' && (
                      <span className="ml-2 text-xs text-gray-400">(fallback)</span>
                    )}
                  </td>
                  <td className={cellCls}>
                    <input type="number" min={0} step={0.01}
                      value={pricing[model]?.input ?? 0}
                      onChange={e => update(model, 'input', e.target.value)}
                      className={numInputCls} />
                  </td>
                  <td className={cellCls}>
                    <input type="number" min={0} step={0.01}
                      value={pricing[model]?.output ?? 0}
                      onChange={e => update(model, 'output', e.target.value)}
                      className={numInputCls} />
                  </td>
                  <td className={`${cellCls} text-right`}>
                    {model !== 'default' && (
                      <button type="button" onClick={() => removeModel(model)}
                        className="text-gray-300 hover:text-red-500 transition-colors" title="Remove">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 border-t border-gray-100 px-3 py-2">
          <input
            type="text"
            value={newModel}
            onChange={e => setNewModel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addModel())}
            placeholder="Add model name, e.g. qwen3.5-9b"
            className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm font-mono focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <Button type="button" size="sm" variant="secondary" onClick={addModel}>+ Add</Button>
        </div>
      </CardBody>
    </Card>
  )
}
