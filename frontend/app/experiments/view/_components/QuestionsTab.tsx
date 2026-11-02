'use client'
import { useEffect, useRef, useState } from 'react'
import { api, Experiment, Question } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/components/ui/Toast'
import { questionTypeLabel } from '@/lib/utils'
import { questionPreview, tokensIn } from './tokens'
import { questionTypeColor } from './distributions'

// ── Questions Tab ─────────────────────────────────────────────────────────────

export function QuestionsTab({ experiment, onChanged }: { experiment: Experiment; onChanged: () => void }) {
  const { toast } = useToast()
  const [pendingDelete, setPendingDelete] = useState<Question | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Question | null>(null)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const draggedId = useRef<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [orderedQuestions, setOrderedQuestions] = useState<Question[]>([])
  const distVars = experiment.dist_variables ?? []
  const varNames = new Set(distVars.map(v => v.name))

  const [form, setForm] = useState({
    question_text: '',
    question_type: 'open_ended' as Question['question_type'],
    sort_order: (experiment.questions?.length ?? 0) + 1,
    ask_why: false,
    scale_min: 1,
    scale_max: 10,
    scale_anchor_low: '',
    scale_anchor_high: '',
    choices: '',
  })

  // Keep orderedQuestions in sync with experiment prop
  useEffect(() => {
    setOrderedQuestions((experiment.questions ?? []).slice().sort((a, b) => a.sort_order - b.sort_order))
  }, [experiment.questions])

  function resetForm() {
    setEditTarget(null)
    setForm({
      question_text: '',
      question_type: 'open_ended',
      sort_order: (experiment.questions?.length ?? 0) + 1,
      ask_why: false,
      scale_min: 1,
      scale_max: 10,
      scale_anchor_low: '',
      scale_anchor_high: '',
      choices: '',
    })
  }

  function openEdit(q: Question) {
    setEditTarget(q)
    setForm({
      question_text: q.question_text,
      question_type: q.question_type,
      sort_order: q.sort_order,
      ask_why: q.ask_why,
      scale_min: q.scale_min ?? 1,
      scale_max: q.scale_max ?? 10,
      scale_anchor_low: q.scale_anchor_low ?? '',
      scale_anchor_high: q.scale_anchor_high ?? '',
      choices: q.choices?.join(', ') ?? '',
    })
    setModalOpen(true)
  }

  function insertVariable(varName: string) {
    const token = `{${varName}}`
    const el = textareaRef.current
    if (!el) { setForm(f => ({ ...f, question_text: f.question_text + token })); return }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const newText = el.value.slice(0, start) + token + el.value.slice(end)
    setForm(f => ({ ...f, question_text: newText }))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length) })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.question_text.trim()) return
    const isScale = form.question_type === 'scale'
    const isChoice = form.question_type === 'multiple_choice' || form.question_type === 'single_choice'
    try {
      setSaving(true)
      const body = {
        question_text: form.question_text.trim(),
        question_type: form.question_type,
        sort_order: form.sort_order,
        ask_why: form.ask_why,
        // Send null for fields that don't apply so switching type clears stale values
        scale_min: isScale ? form.scale_min : null,
        scale_max: isScale ? form.scale_max : null,
        scale_anchor_low: isScale ? form.scale_anchor_low.trim() || null : null,
        scale_anchor_high: isScale ? form.scale_anchor_high.trim() || null : null,
        choices: isChoice ? form.choices.split(',').map(s => s.trim()).filter(Boolean) : null,
      }
      if (editTarget) {
        await api.updateQuestion(experiment.id, editTarget.id, body)
        toast('Question updated', 'success')
      } else {
        await api.addQuestion(experiment.id, body as Omit<Question, 'id' | 'experiment_id'>)
        toast('Question added', 'success')
      }
      setModalOpen(false)
      resetForm()
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed to save question', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(qId: string) {
    setPendingDelete(null)
    try {
      await api.deleteQuestion(experiment.id, qId)
      toast('Question deleted', 'success')
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error')
    }
  }

  // ── Drag & drop handlers ──────────────────────────────────────────────────

  function handleDragStart(id: string) {
    draggedId.current = id
  }

  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault()
    setDragOverId(id)
  }

  function handleDragEnd() {
    draggedId.current = null
    setDragOverId(null)
  }

  async function handleDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault()
    const srcId = draggedId.current
    if (!srcId || srcId === targetId) { setDragOverId(null); return }

    const qs = [...orderedQuestions]
    const srcIdx = qs.findIndex(q => q.id === srcId)
    const tgtIdx = qs.findIndex(q => q.id === targetId)
    if (srcIdx === -1 || tgtIdx === -1) return

    // Reorder optimistically
    const [moved] = qs.splice(srcIdx, 1)
    qs.splice(tgtIdx, 0, moved)
    setOrderedQuestions(qs)
    setDragOverId(null)
    draggedId.current = null

    try {
      await api.reorderQuestions(experiment.id, qs.map(q => q.id))
      onChanged()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Reorder failed', 'error')
      // Revert on failure
      onChanged()
    }
  }

  const inputCls = 'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500'

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-800">Questions</h2>
          {orderedQuestions.length > 1 && (
            <p className="text-xs text-gray-400 mt-0.5">Drag rows to reorder</p>
          )}
        </div>
        <Button size="sm" onClick={() => { resetForm(); setModalOpen(true) }}>+ Add Question</Button>
      </div>

      {orderedQuestions.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-gray-500 text-center py-6">No questions yet. Add some to define what will be asked.</p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="divide-y divide-gray-100">
            {orderedQuestions.map((q, i) => (
              <div
                key={q.id}
                draggable
                onDragStart={() => handleDragStart(q.id)}
                onDragOver={e => handleDragOver(e, q.id)}
                onDragEnd={handleDragEnd}
                onDrop={e => handleDrop(e, q.id)}
                className={`px-5 py-4 flex items-start gap-3 transition-colors ${
                  dragOverId === q.id ? 'bg-indigo-50' : 'hover:bg-gray-50'
                }`}
              >
                {/* Drag handle */}
                <div className="mt-1 flex-shrink-0 cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
                  </svg>
                </div>
                {/* Order badge */}
                <span className="mt-0.5 flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-indigo-50 text-xs font-semibold text-indigo-600">
                  {i + 1}
                </span>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800">{q.question_text}</p>
                  {tokensIn(q.question_text).filter(t => !varNames.has(t)).map(t => (
                    <p key={t} className="mt-1 text-xs text-amber-700">
                      <code>{`{${t}}`}</code> isn&apos;t a variable — it will be sent literally. Add it in the Variables tab or fix the spelling.
                    </p>
                  ))}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Badge color={questionTypeColor(q.question_type)}>{questionTypeLabel(q.question_type)}</Badge>
                    {q.ask_why && <Badge color="yellow">ask why</Badge>}
                    {q.question_type === 'scale' && (
                      <span className="text-xs text-gray-500">
                        {q.scale_min} – {q.scale_max}
                        {q.scale_anchor_low && ` · "${q.scale_anchor_low}"`}
                        {q.scale_anchor_high && ` → "${q.scale_anchor_high}"`}
                      </span>
                    )}
                    {(q.question_type === 'multiple_choice' || q.question_type === 'single_choice') && q.choices && (
                      <span className="text-xs text-gray-500">{q.choices.join(', ')}</span>
                    )}
                  </div>
                </div>
                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => openEdit(q)}
                    className="text-gray-400 hover:text-indigo-600 transition-colors"
                    title="Edit question"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setPendingDelete(q)}
                    className="text-gray-500 hover:text-red-700 transition-colors"
                    title="Delete question"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal open={modalOpen} onClose={() => { setModalOpen(false); resetForm() }} title={editTarget ? 'Edit Question' : 'Add Question'} size="lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Question Text <span className="text-red-500">*</span>
            </label>
            <textarea
              ref={textareaRef}
              required
              value={form.question_text}
              onChange={e => setForm(f => ({ ...f, question_text: e.target.value }))}
              rows={3}
              className={inputCls}
              placeholder="What do you think about…"
            />
            {distVars.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5 items-center">
                <span className="text-xs text-gray-400">Insert:</span>
                {distVars.map(v => (
                  <button key={v.id} type="button" onClick={() => insertVariable(v.name)}
                    className="inline-flex items-center rounded bg-indigo-50 px-2 py-0.5 text-xs font-mono text-indigo-700 hover:bg-indigo-100 transition-colors">
                    {'{' + v.name + '}'}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Type</label>
            <select value={form.question_type}
              onChange={e => setForm(f => ({ ...f, question_type: e.target.value as Question['question_type'] }))}
              className={inputCls}>
              <option value="open_ended">Open-ended</option>
              <option value="scale">Scale</option>
              <option value="single_choice">Single choice</option>
              <option value="multiple_choice">Multiple choice</option>
            </select>
          </div>

          {form.question_type === 'scale' && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Scale Min</label>
                  <input type="number" value={form.scale_min}
                    onChange={e => setForm(f => ({ ...f, scale_min: parseInt(e.target.value) }))}
                    className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Scale Max</label>
                  <input type="number" value={form.scale_max}
                    onChange={e => setForm(f => ({ ...f, scale_max: parseInt(e.target.value) }))}
                    className={inputCls} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Low anchor label <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input type="text" value={form.scale_anchor_low}
                    onChange={e => setForm(f => ({ ...f, scale_anchor_low: e.target.value }))}
                    className={inputCls} placeholder="e.g. Not at all likely" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">High anchor label <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input type="text" value={form.scale_anchor_high}
                    onChange={e => setForm(f => ({ ...f, scale_anchor_high: e.target.value }))}
                    className={inputCls} placeholder="e.g. Extremely likely" />
                </div>
              </div>
            </>
          )}

          {(form.question_type === 'multiple_choice' || form.question_type === 'single_choice') && (
            <div>
              <label className="block text-sm font-medium text-gray-700">Choices (comma-separated)</label>
              <input type="text" value={form.choices}
                onChange={e => setForm(f => ({ ...f, choices: e.target.value }))}
                className={inputCls}
                placeholder="Strongly Agree, Agree, Neutral, Disagree, Strongly Disagree" />
            </div>
          )}

          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.ask_why}
                onChange={e => setForm(f => ({ ...f, ask_why: e.target.checked }))}
                className="rounded border-gray-300 text-indigo-600" />
              <span className="font-medium text-gray-700">Ask follow-up &ldquo;Why?&rdquo;</span>
            </label>
          </div>

          <div className="rounded-[10px] border border-gray-100 bg-white/[0.025] p-3">
            <p className="mb-1.5 text-[11px] uppercase tracking-[0.06em] text-gray-500">Respondents will be asked</p>
            <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800">{questionPreview({
              ...form,
              choices: form.choices.split(',').map(c => c.trim()).filter(Boolean),
            })}</pre>
            {tokensIn(form.question_text).some(t => !varNames.has(t)) && (
              <p className="mt-2 text-xs text-amber-700">
                Unknown variable{tokensIn(form.question_text).filter(t => !varNames.has(t)).length > 1 ? 's' : ''}:{' '}
                {tokensIn(form.question_text).filter(t => !varNames.has(t)).map(t => `{${t}}`).join(', ')}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => { setModalOpen(false); resetForm() }}>Cancel</Button>
            <Button type="submit" loading={saving}>{editTarget ? 'Save Changes' : 'Add Question'}</Button>
          </div>
        </form>
      </Modal>
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete question?"
        confirmLabel="Delete"
        danger
        onConfirm={() => pendingDelete && handleDelete(pendingDelete.id)}
        onClose={() => setPendingDelete(null)}
      >
        &ldquo;{pendingDelete?.question_text}&rdquo; will be removed from the experiment. Past runs are not affected.
      </ConfirmDialog>
    </div>
  )
}
