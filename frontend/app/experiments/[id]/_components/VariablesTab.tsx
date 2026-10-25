'use client'
import { useState } from 'react'
import { api, Experiment, ExperimentDistVariable } from '@/lib/api'
import { truncate } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/components/ui/Toast'
import { VarFormState, defaultVarForm, buildDistribution, distSummary, VarFormFields, DistType, CatOption } from './distributions'

// ── Variables Tab ─────────────────────────────────────────────────────────────

export function VariablesTab({ experiment, onChanged }: { experiment: Experiment; onChanged: () => void }) {
  const { toast } = useToast()
  const [pendingDelete, setPendingDelete] = useState<ExperimentDistVariable | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ExperimentDistVariable | null>(null)
  const [form, setForm] = useState<VarFormState>(defaultVarForm())
  const [saving, setSaving] = useState(false)

  function openAdd() { setEditTarget(null); setForm(defaultVarForm()); setModalOpen(true) }

  function openEdit(v: ExperimentDistVariable) {
    setEditTarget(v)
    const d = v.distribution as Record<string, unknown>
    const t = d.type as DistType
    const base: Partial<VarFormState> = {
      name: v.name, var_type: v.var_type, sort_order: v.sort_order,
      dist_type: t === 'categorical' ? 'categorical' : t,
    }
    if (t === 'normal') { base.mean = String(d.mean ?? 0); base.std = String(d.std ?? 1) }
    else if (t === 'log_normal') { base.real_mean = String(d.real_mean ?? 50000); base.real_std = String(d.real_std ?? 20000) }
    else if (t === 'uniform') { base.min = String(d.min ?? 0); base.max = String(d.max ?? 1) }
    else if (t === 'triangular') { base.min = String(d.min ?? 0); base.max = String(d.max ?? 1); base.mode = String(d.mode ?? 0.5) }
    else if (t === 'beta') { base.alpha = String(d.alpha ?? 2); base.beta = String(d.beta ?? 5) }
    else if (t === 'exponential') { base.lambda = String(d.lambda ?? 1) }
    else if (t === 'gamma') { base.alpha = String(d.alpha ?? 2); base.beta = String(d.beta ?? 1) }
    else if (t === 'categorical') { base.cat_options = (d.options as CatOption[]) ?? [] }
    setForm(f => ({ ...f, ...base }))
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) return
    try {
      setSaving(true)
      const body = { name: form.name.trim(), var_type: form.var_type, distribution: buildDistribution(form), sort_order: form.sort_order }
      if (editTarget) {
        await api.updateExpDistVariable(experiment.id, editTarget.id, body)
        toast('Variable updated', 'success')
      } else {
        await api.addExpDistVariable(experiment.id, body)
        toast('Variable added', 'success')
      }
      setModalOpen(false)
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(v: ExperimentDistVariable) {
    setPendingDelete(null)
    try {
      await api.deleteExpDistVariable(experiment.id, v.id)
      toast('Variable deleted', 'success')
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error')
    }
  }

  const vars = (experiment.dist_variables ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)

  // Compute which variable names are referenced in any question text
  const allQuestionText = (experiment.questions ?? []).map(q => q.question_text).join(' ')
  const referencedVarNames = new Set(
    Array.from(allQuestionText.matchAll(/\{([^}]+)\}/g), m => m[1])
  )

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-800">Experiment Variables</h2>
          <p className="text-xs text-gray-400 mt-0.5">Use <code className="bg-gray-100 px-1 rounded">{'{variable_name}'}</code> in question text to inject a sampled value at interview time.</p>
        </div>
        <Button size="sm" onClick={openAdd}>+ Add Variable</Button>
      </div>

      {vars.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-gray-500 text-center py-6">No variables yet. Add one to inject dynamic sampled values into question text.</p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="divide-y divide-gray-100">
            {vars.map(v => {
              const isUsed = referencedVarNames.has(v.name)
              return (
              <div key={v.id} className="flex items-center gap-4 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-semibold text-indigo-700">{'{' + v.name + '}'}</code>
                    <Badge color={v.var_type === 'continuous' ? 'blue' : 'purple'}>{v.var_type}</Badge>
                    {isUsed && <span className="text-xs text-green-600 font-medium">used in questions</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{distSummary(v)}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" variant="outline" onClick={() => openEdit(v)}>Edit</Button>
                  <button onClick={() => setPendingDelete(v)} className="text-gray-300 hover:text-red-500 transition-colors" title="Delete">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              </div>
            )})}
          </div>
        </Card>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editTarget ? 'Edit Variable' : 'Add Variable'} size="lg">
        <div className="space-y-4">
          <VarFormFields form={form} setForm={setForm} />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button loading={saving} onClick={handleSave} disabled={!form.name.trim()}>{editTarget ? 'Save Changes' : 'Add Variable'}</Button>
          </div>
        </div>
      </Modal>
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete variable?"
        confirmLabel="Delete"
        danger
        onConfirm={() => pendingDelete && handleDelete(pendingDelete)}
        onClose={() => setPendingDelete(null)}
      >
        <strong>{pendingDelete?.name}</strong> will be removed. Questions that still use{' '}
        <code>{`{${pendingDelete?.name}}`}</code> will show the token literally.
      </ConfirmDialog>
    </div>
  )
}
