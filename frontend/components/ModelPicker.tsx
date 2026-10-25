'use client'
import { useEffect, useState } from 'react'

const CUSTOM = '__custom__'

/**
 * Model dropdown with a "Custom…" escape hatch for names not in the list
 * (e.g. a local LM Studio model). Used by Settings and the Launch tab.
 */
export function ModelPicker({ value, onChange, options, inheritLabel, className = '' }: {
  value: string
  onChange: (v: string) => void
  options: string[]
  /** When set, an empty value means "inherit" and is offered as the first option. */
  inheritLabel?: string
  className?: string
}) {
  const known = options.includes(value) || (inheritLabel !== undefined && value === '')
  const [custom, setCustom] = useState(!known)

  useEffect(() => { if (!known) setCustom(true) }, [known])

  const base = `mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-300 ${className}`

  if (custom) {
    return (
      <div className="flex gap-2">
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="exact model id"
          className={base}
          autoFocus={known}
        />
        <button type="button" onClick={() => { setCustom(false); if (!options.includes(value)) onChange(inheritLabel !== undefined ? '' : options[0] ?? '') }}
          className="mt-1 whitespace-nowrap rounded-lg px-2 text-xs text-gray-500 hover:text-gray-900">
          List
        </button>
      </div>
    )
  }
  return (
    <select
      value={value}
      onChange={e => { if (e.target.value === CUSTOM) setCustom(true); else onChange(e.target.value) }}
      className={base}
    >
      {inheritLabel !== undefined && <option value="">{inheritLabel}</option>}
      {options.map(m => <option key={m} value={m}>{m}</option>)}
      <option value={CUSTOM}>Custom…</option>
    </select>
  )
}
