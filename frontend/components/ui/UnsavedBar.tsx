'use client'
import { useEffect } from 'react'
import { Button } from './Button'

/**
 * Sticky bar shown while a page has unsaved edits, with a single Save / Discard.
 * Also asks the browser to warn before leaving the page.
 */
export function UnsavedBar({ dirty, saving, onSave, onDiscard, message = 'You have unsaved changes' }: {
  dirty: boolean; saving?: boolean; onSave: () => void; onDiscard: () => void; message?: string
}) {
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  if (!dirty) return null
  return (
    <div className="sticky bottom-4 z-30 mt-6 flex items-center justify-between gap-4 rounded-[12px] border border-amber-300 bg-panel-strong px-5 py-3 shadow-panel">
      <span className="flex items-center gap-2 text-sm text-amber-700">
        <span className="h-2 w-2 rounded-full bg-amber-500" /> {message}
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>Discard</Button>
        <Button size="sm" loading={saving} onClick={onSave}>Save changes</Button>
      </div>
    </div>
  )
}
