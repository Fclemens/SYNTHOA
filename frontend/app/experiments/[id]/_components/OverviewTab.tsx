'use client'
import { useEffect, useState } from 'react'
import { api, Experiment } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { useToast } from '@/components/ui/Toast'

// ── Overview Tab ─────────────────────────────────────────────────────────────

export function OverviewTab({ experiment, onSaved }: { experiment: Experiment; onSaved: () => void }) {
  const { toast } = useToast()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [audiences, setAudiences] = useState<{ id: string; name: string }[]>([])
  const [form, setForm] = useState({
    audience_id: experiment.audience_id,
    name: experiment.name,
    global_context: experiment.global_context ?? '',
    execution_mode: experiment.execution_mode,
    drift_detection_enabled: experiment.drift_detection_enabled ?? true,
  })

  useEffect(() => {
    api.listAudiences().then(list => setAudiences(list)).catch(() => {})
  }, [])

  async function handleSave() {
    try {
      setSaving(true)
      await api.updateExperiment(experiment.id, form)
      toast('Saved', 'success')
      setEditing(false)
      onSaved()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  const currentAudienceName = audiences.find(a => a.id === experiment.audience_id)?.name ?? experiment.audience_id

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Experiment Details</h2>
          {!editing ? (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" loading={saving} onClick={handleSave}>Save</Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Audience</label>
          {editing ? (
            <select
              value={form.audience_id}
              onChange={e => setForm(f => ({ ...f, audience_id: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              {audiences.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          ) : (
            <p className="text-gray-900">{currentAudienceName}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Name</label>
          {editing ? (
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          ) : (
            <p className="text-gray-900">{experiment.name}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Execution Mode</label>
          {editing ? (
            <>
              <select
                value={form.execution_mode}
                onChange={e => setForm(f => ({ ...f, execution_mode: e.target.value as 'pooled' | 'dedicated' }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="pooled">Pooled — all questions in one LLM call (fast, cheaper)</option>
                <option value="dedicated">Dedicated — one LLM call per question, multi-turn interview (realistic, costlier)</option>
              </select>
            </>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge color={experiment.execution_mode === 'pooled' ? 'blue' : 'purple'}>
                {experiment.execution_mode}
              </Badge>
              <span className="text-xs text-gray-400">
                {experiment.execution_mode === 'pooled'
                  ? 'All questions in one LLM call'
                  : 'One LLM call per question, multi-turn interview'}
              </span>
            </div>
          )}
        </div>

        {(editing ? form.execution_mode === 'dedicated' : experiment.execution_mode === 'dedicated') && (
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Drift Detection
              <span className="ml-1 normal-case font-normal text-gray-400">(dedicated mode only)</span>
            </label>
            {editing ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.drift_detection_enabled}
                  onChange={e => setForm(f => ({ ...f, drift_detection_enabled: e.target.checked }))}
                  className="rounded border-gray-300 text-indigo-600"
                />
                <span>Enabled — inject adherence checkpoints every 3 questions</span>
              </label>
            ) : (
              <div className="flex items-center gap-2">
                <Badge color={experiment.drift_detection_enabled ? 'green' : 'gray'}>
                  {experiment.drift_detection_enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                <span className="text-xs text-gray-400">
                  {experiment.drift_detection_enabled
                    ? 'Adds ~2 LLM calls every 3 questions to score persona adherence'
                    : 'No extra calls — faster and cheaper, no adherence scoring'}
                </span>
              </div>
            )}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Global Context</label>
          {editing ? (
            <textarea
              value={form.global_context}
              onChange={e => setForm(f => ({ ...f, global_context: e.target.value }))}
              rows={5}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="Background context shown at the start of each interview…"
            />
          ) : (
            <p className="text-sm text-gray-700 whitespace-pre-wrap">
              {experiment.global_context || <span className="text-gray-400 italic">None</span>}
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
