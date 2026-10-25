import { Experiment } from '@/lib/api'

/** {name} tokens referenced in a piece of text. */
export function tokensIn(text: string): string[] {
  return Array.from(text.matchAll(/\{([^{}]+)\}/g), m => m[1].trim())
}

export interface TokenReport {
  /** variable name → where it is used */
  usage: Record<string, { context: boolean; questions: number[] }>
  /** variables defined but never referenced */
  unused: string[]
  /** tokens referenced but not defined (they would reach the model as literal "{x}") */
  unknown: { token: string; where: string }[]
}

export function tokenReport(experiment: Experiment): TokenReport {
  const names = new Set((experiment.dist_variables ?? []).map(v => v.name))
  const usage: TokenReport['usage'] = {}
  for (const n of Array.from(names)) usage[n] = { context: false, questions: [] }
  const unknown: TokenReport['unknown'] = []

  for (const t of tokensIn(experiment.global_context ?? '')) {
    if (usage[t]) usage[t].context = true
    else unknown.push({ token: t, where: 'context' })
  }
  const questions = [...(experiment.questions ?? [])].sort((a, b) => a.sort_order - b.sort_order)
  questions.forEach((q, i) => {
    for (const t of tokensIn(q.question_text)) {
      if (usage[t]) { if (!usage[t].questions.includes(i + 1)) usage[t].questions.push(i + 1) }
      else unknown.push({ token: t, where: `Q${i + 1}` })
    }
  })
  const unused = Object.entries(usage).filter(([, u]) => !u.context && u.questions.length === 0).map(([n]) => n)
  return { usage, unused, unknown }
}

/** Mirrors the backend's format_question (dedicated mode): what the respondent model is asked. */
export function questionPreview(q: {
  question_text: string; question_type: string; scale_min?: number | null; scale_max?: number | null
  scale_anchor_low?: string | null; scale_anchor_high?: string | null; choices?: string[] | null; ask_why?: boolean
}): string {
  const lines = [q.question_text.trim() || '…']
  if (q.question_type === 'scale') {
    const lo = q.scale_min ?? 1, hi = q.scale_max ?? 10
    const anchors = [
      q.scale_anchor_low ? `${lo} = "${q.scale_anchor_low}"` : null,
      q.scale_anchor_high ? `${hi} = "${q.scale_anchor_high}"` : null,
    ].filter(Boolean)
    lines.push(`(Answer on a scale of ${lo} to ${hi}${anchors.length ? `, where ${anchors.join(' and ')}` : ''})`)
  } else if (q.question_type === 'single_choice' && q.choices?.length) {
    lines.push(`Select ONE option: ${q.choices.join(', ')}`)
  } else if (q.question_type === 'multiple_choice' && q.choices?.length) {
    lines.push(`Options (select all that apply): ${q.choices.join(', ')}`)
  }
  if (q.ask_why) lines.push('Please think through your reasoning before answering.')
  return lines.join('\n')
}
