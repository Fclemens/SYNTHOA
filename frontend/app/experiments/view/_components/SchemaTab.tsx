'use client'
import { useState } from 'react'
import { api, Experiment, Question, SchemaField, OutputSchema } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'

// ── Schema Tab ────────────────────────────────────────────────────────────────

export function SchemaTab({ experiment, onChanged }: { experiment: Experiment; onChanged: () => void }) {
  const { toast } = useToast()
  const currentSchema: OutputSchema | undefined = experiment.output_schemas?.[0]
  const existingFields: SchemaField[] = currentSchema?.schema_json ?? []

  const [modalOpen, setModalOpen] = useState(false)
  const [fields, setFields] = useState<SchemaField[]>(existingFields)
  const [saving, setSaving] = useState(false)
  const [newField, setNewField] = useState({ key: '', type: 'string', description: '', enum_values: '' })

  function openModal(prefill = false) {
    const base = existingFields.map(normalizeField)
    setFields(prefill ? [...base, ...suggestFieldsFromQuestions(experiment.questions ?? [])
      .filter(s => !base.some(f => f.key === s.key))] : base)
    setModalOpen(true)
  }

  const enumValues = newField.enum_values.split(',').map(s => s.trim()).filter(Boolean)
  const keyTaken = fields.some(f => f.key === newField.key.trim())
  const canAdd = !!newField.key.trim() && !keyTaken && (newField.type !== 'enum' || enumValues.length > 0)

  function addField() {
    if (!canAdd) return
    const field: SchemaField = {
      key: newField.key.trim(),
      type: newField.type,
      description: newField.description.trim() || undefined,
      ...(newField.type === 'enum' && { values: enumValues }),
    }
    setFields(f => [...f, field])
    setNewField({ key: '', type: 'string', description: '', enum_values: '' })
  }

  function addSuggestions() {
    const suggested = suggestFieldsFromQuestions(experiment.questions ?? [])
      .filter(s => !fields.some(f => f.key === s.key))
    setFields(f => [...f, ...suggested])
  }

  async function handleSave() {
    try {
      setSaving(true)
      await api.createOutputSchema(experiment.id, fields)
      toast('Schema saved', 'success')
      setModalOpen(false)
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold text-gray-800">Output Schema</h2>
        <Button size="sm" onClick={() => openModal()}>
          {existingFields.length > 0 ? 'Edit Schema' : 'Define Schema'}
        </Button>
      </div>

      {existingFields.length === 0 ? (
        <Card>
          <CardBody>
            <div className="py-6 text-center">
              <p className="text-sm text-gray-500">
                No output schema yet. It decides which answers are extracted from each interview.
              </p>
              {(experiment.questions?.length ?? 0) > 0 && (
                <Button size="sm" variant="outline" className="mt-3" onClick={() => openModal(true)}>
                  Start from my {experiment.questions.length} question{experiment.questions.length !== 1 ? 's' : ''}
                </Button>
              )}
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Key</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {existingFields.map((f, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-indigo-700">{f.key}</td>
                    <td className="px-4 py-3">
                      <Badge color="gray">{fieldTypeLabel(f)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{f.description ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Edit Output Schema" size="xl">
        <div className="space-y-4">
          {/* Current fields */}
          {fields.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Fields</h3>
              <div className="rounded-lg border border-gray-200 divide-y divide-gray-100">
                {fields.map((f, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="flex-1 font-mono text-xs text-indigo-700">{f.key}</span>
                    <Badge color="gray">{fieldTypeLabel(f)}</Badge>
                    <span className="flex-1 text-xs text-gray-500">{f.description ?? ''}</span>
                    <button
                      onClick={() => setFields(fs => fs.filter((_, j) => j !== i))}
                      className="text-gray-300 hover:text-red-500"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add field form */}
          <div className="rounded-lg bg-gray-50 p-4 space-y-3">
            <h3 className="text-sm font-medium text-gray-700">Add Field</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Key</label>
                <input
                  type="text"
                  value={newField.key}
                  onChange={e => setNewField(f => ({ ...f, key: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="brand_satisfaction"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Type</label>
                <select
                  value={newField.type}
                  onChange={e => setNewField(f => ({ ...f, type: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="string">string</option>
                  <option value="integer">integer</option>
                  <option value="float">float</option>
                  <option value="boolean">boolean</option>
                  <option value="scale">scale (1–10)</option>
                  <option value="enum">enum</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Description</label>
              <input
                type="text"
                value={newField.description}
                onChange={e => setNewField(f => ({ ...f, description: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                placeholder="Optional description"
              />
            </div>
            {newField.type === 'enum' && (
              <div>
                <label className="block text-xs text-gray-600 mb-1">Enum values (comma-separated)</label>
                <input
                  type="text"
                  value={newField.enum_values}
                  onChange={e => setNewField(f => ({ ...f, enum_values: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="low,medium,high"
                />
              </div>
            )}
            <div className="flex items-center gap-3">
              <Button size="sm" variant="outline" onClick={addField} disabled={!canAdd}>
                + Add Field
              </Button>
              {keyTaken && <span className="text-xs text-red-600">A field with this key already exists</span>}
              {(experiment.questions?.length ?? 0) > 0 && (
                <button type="button" onClick={addSuggestions} className="ml-auto text-xs font-medium text-indigo-600 hover:text-indigo-800">
                  + Suggest fields from questions
                </button>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button loading={saving} onClick={handleSave} disabled={fields.length === 0}>Save Schema</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}


// ── Helpers ───────────────────────────────────────────────────────────────────

/** Older schemas stored enums as type "enum(a,b)"; show and edit them as enum + values. */
function normalizeField(f: SchemaField): SchemaField {
  const m = /^enum\((.*)\)$/.exec(f.type)
  return m ? { ...f, type: 'enum', values: m[1].split(',').map(v => v.trim()).filter(Boolean) } : f
}

function fieldTypeLabel(f: SchemaField): string {
  const n = normalizeField(f)
  return n.type === 'enum' ? `enum: ${(n.values ?? []).join(' / ')}` : n.type
}

function slug(text: string): string {
  return text.toLowerCase().replace(/\{[^}]*\}/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    .split('_').slice(0, 4).join('_')
}

/** One output field per question, typed from the question's answer format. */
export function suggestFieldsFromQuestions(questions: Question[]): SchemaField[] {
  return [...questions].sort((a, b) => a.sort_order - b.sort_order).map((q, i) => {
    const key = `q${i + 1}_${slug(q.question_text) || 'answer'}`
    switch (q.question_type) {
      case 'scale': {
        const lo = q.scale_min ?? 1, hi = q.scale_max ?? 10
        return { key, type: 'integer', description: `Q${i + 1} rating from ${lo} to ${hi}` }
      }
      case 'single_choice':
        return q.choices?.length
          ? { key, type: 'enum', values: q.choices, description: `Q${i + 1} selected option` }
          : { key, type: 'string', description: `Q${i + 1} selected option` }
      case 'multiple_choice':
        return { key, type: 'string', description: `Q${i + 1} all selected options, comma-separated${q.choices?.length ? ` (from: ${q.choices.join(', ')})` : ''}` }
      default:
        return { key, type: 'string', description: `Q${i + 1} answer summarised in one or two sentences` }
    }
  })
}
