'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface Props {
  open: boolean
  promptName: string
  title: string
  onClose: () => void
}

export default function PromptEditorModal({ open, promptName, title, onClose }: Props) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setSaved(false)
    api.getPrompt(promptName)
      .then(r => setContent(r.content))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [open, promptName])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.updatePrompt(promptName, content)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl flex flex-col" style={{ maxHeight: '80vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Use <code className="bg-gray-100 px-1 rounded text-xs">{'{field_key}'}</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">{'{answers}'}</code>, etc. as placeholders.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-400 text-sm">Loading…</div>
          ) : error ? (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
          ) : (
            <textarea
              className="w-full rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 resize-none"
              style={{ minHeight: '320px' }}
              value={content}
              onChange={e => setContent(e.target.value)}
              spellCheck={false}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3">
          <p className="text-xs text-gray-400">Changes are saved to disk and take effect immediately.</p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
            >
              Close
            </button>
            <button
              onClick={handleSave}
              disabled={saving || loading}
              className="rounded-lg px-4 py-1.5 text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
