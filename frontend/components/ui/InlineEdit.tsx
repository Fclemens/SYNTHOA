'use client'
import { useState } from 'react'

/** Click-to-edit text (titles, run names). Enter saves, Escape cancels. */
export function InlineEdit({ value, placeholder, onSave, className = '' }: {
  value: string; placeholder?: string; onSave: (v: string) => Promise<void> | void; className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  async function commit() {
    setEditing(false)
    if (draft.trim() !== value) await onSave(draft.trim())
  }

  if (editing) {
    return (
      <input
        autoFocus
        onFocus={e => e.target.select()}
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        className={`rounded-lg border border-indigo-300 px-2 py-0.5 outline-none ${className}`}
      />
    )
  }
  return (
    <button type="button" onClick={() => { setDraft(value); setEditing(true) }} title="Click to rename"
      className={`group inline-flex items-center gap-2 rounded-lg text-left hover:text-indigo-700 ${className}`}>
      {value || placeholder}
      <svg className="h-4 w-4 flex-none text-gray-400 opacity-0 transition-opacity group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2.414a2 2 0 01.586-1.414z" />
      </svg>
    </button>
  )
}
