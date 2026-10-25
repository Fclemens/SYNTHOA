'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, Audience, Experiment } from '@/lib/api'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { UnsavedBar } from '@/components/ui/UnsavedBar'
import { useToast } from '@/components/ui/Toast'
import { tokenReport } from './tokens'

const inputCls = 'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-300'
const labelCls = 'block text-[11px] font-medium uppercase tracking-[0.06em] text-gray-500'

type Form = Pick<Experiment, 'audience_id' | 'global_context' | 'execution_mode' | 'drift_detection_enabled'>

const fromExperiment = (e: Experiment): Form => ({
  audience_id: e.audience_id,
  global_context: e.global_context ?? '',
  execution_mode: e.execution_mode,
  drift_detection_enabled: e.drift_detection_enabled ?? true,
})

// ── Overview Tab ─────────────────────────────────────────────────────────────

export function OverviewTab({ experiment, onSaved }: { experiment: Experiment; onSaved: () => void }) {
  const { toast } = useToast()
  const [audiences, setAudiences] = useState<Audience[]>([])
  const [form, setForm] = useState<Form>(fromExperiment(experiment))
  const [saving, setSaving] = useState(false)

  useEffect(() => { api.listAudiences().then(setAudiences).catch(() => {}) }, [])
  useEffect(() => { setForm(fromExperiment(experiment)) }, [experiment])

  const saved = fromExperiment(experiment)
  const dirty = (Object.keys(form) as (keyof Form)[]).some(k => form[k] !== saved[k])
  const audience = audiences.find(a => a.id === form.audience_id)
  const unknown = tokenReport({ ...experiment, global_context: form.global_context }).unknown.filter(u => u.where === 'context')

  async function handleSave() {
    try {
      setSaving(true)
      await api.updateExperiment(experiment.id, form)
      toast('Saved', 'success')
      onSaved()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><h2 className="font-semibold text-gray-900">Setup</h2></CardHeader>
        <CardBody className="space-y-5">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <label className={labelCls}>Audience</label>
              <select value={form.audience_id} onChange={e => setForm(f => ({ ...f, audience_id: e.target.value }))} className={inputCls}>
                {audiences.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              {audience && (
                <p className="mt-1 text-xs text-gray-500">
                  {audience.persona_count ?? 0} personas · {audience.variables.length} variables ·{' '}
                  <Link href={`/audiences/${audience.id}`} className="text-indigo-400 hover:underline">open audience</Link>
                </p>
              )}
            </div>
            <div>
              <label className={labelCls}>Interview mode</label>
              <select value={form.execution_mode}
                onChange={e => setForm(f => ({ ...f, execution_mode: e.target.value as Form['execution_mode'] }))} className={inputCls}>
                <option value="pooled">Pooled — all questions in one call (fast, cheaper)</option>
                <option value="dedicated">Dedicated — one turn per question (realistic, costlier)</option>
              </select>
              {form.execution_mode === 'dedicated' && (
                <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={form.drift_detection_enabled}
                    onChange={e => setForm(f => ({ ...f, drift_detection_enabled: e.target.checked }))} />
                  Drift detection <span className="text-xs text-gray-500">(checks the persona stays in character every 3 questions; adds calls)</span>
                </label>
              )}
            </div>
          </div>

          <div>
            <label className={labelCls}>Context shown before the questions</label>
            <textarea
              value={form.global_context}
              onChange={e => setForm(f => ({ ...f, global_context: e.target.value }))}
              rows={5}
              className={inputCls}
              placeholder="e.g. A company offers an e-bike subscription at {price} per month, including maintenance."
            />
            <p className="mt-1 text-xs text-gray-500">
              Use <code>{'{variable}'}</code> to insert an experiment variable. Every respondent reads this before answering.
            </p>
            {unknown.length > 0 && (
              <p className="mt-1 text-xs text-amber-700">
                Not defined as variables: {unknown.map(u => `{${u.token}}`).join(', ')} — they would be sent literally.
              </p>
            )}
          </div>
        </CardBody>
      </Card>

      <UnsavedBar dirty={dirty} saving={saving} onSave={handleSave} onDiscard={() => setForm(saved)} />
    </div>
  )
}
