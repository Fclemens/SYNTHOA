'use client'
import { useEffect, useState } from 'react'
import { api, PreviewInterviewResult } from '@/lib/api'
import { fmtCost, fmtTokens } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">{title}</h3>
      {children}
    </div>
  )
}

const preCls = 'max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-xs text-gray-800'

/** Runs one real interview + extraction on a random persona and shows exactly what happened. */
export function PreviewInterviewModal({
  open, experimentId, model, onClose,
}: { open: boolean; experimentId: string; model?: string; onClose: () => void }) {
  const [result, setResult] = useState<PreviewInterviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  async function run() {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api.previewInterview(experimentId, { model: model || undefined }))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    if (open) run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Modal open={open} onClose={onClose} title="Test interview — 1 persona" size="xl">
      <div className="space-y-5">
        {running && (
          <div className="flex items-center gap-3 py-10 justify-center text-sm text-gray-500">
            <Spinner /> Interviewing a random persona…
          </div>
        )}
        {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {result && (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
              <span>Tokens: {fmtTokens(result.pass1_tokens_in)} in / {fmtTokens(result.pass1_tokens_out)} out</span>
              <span>Interview cost: {fmtCost(result.pass1_cost_usd)}</span>
              {Object.keys(result.resolved_variables).length > 0 && (
                <span>Variables: {Object.entries(result.resolved_variables).map(([k, v]) => `${k} = ${v}`).join(', ')}</span>
              )}
            </div>
            <Section title="Persona">
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(result.persona_traits).map(([k, v]) => (
                  <span key={k} className="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-800">{k}: {String(v)}</span>
                ))}
              </div>
            </Section>
            <Section title="Transcript"><pre className={preCls}>{result.transcript}</pre></Section>
            {result.extracted_json && (
              <Section title="Extracted answers">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-gray-100">
                    {Object.entries(result.extracted_json).map(([k, v]) => (
                      <tr key={k}>
                        <td className="py-1.5 pr-4 font-mono text-indigo-700">{k}</td>
                        <td className="py-1.5 text-gray-800">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                        <td className="py-1.5 text-right text-gray-400">
                          {result.extraction_confidence?.[k] !== undefined && `${Math.round(result.extraction_confidence[k] * 100)}% conf.`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}
            <details>
              <summary className="cursor-pointer text-xs font-medium text-gray-500 hover:text-gray-700">Exact prompt sent</summary>
              <pre className={`${preCls} mt-2`}>{result.assembled_prompt}</pre>
            </details>
          </>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="outline" loading={running} onClick={run}>Try another persona</Button>
        </div>
      </div>
    </Modal>
  )
}
