'use client'
import { useEffect, useRef, useState } from 'react'

export interface MenuItem { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }

/** "⋯" button with a small dropdown — keeps rare and destructive actions out of the way. */
export function OverflowMenu({ items, label = 'More actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o) }}
        className="grid h-8 w-8 place-items-center rounded-lg border border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-900"
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><circle cx="4" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="16" cy="10" r="1.6" /></svg>
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 min-w-[170px] overflow-hidden rounded-[10px] border border-gray-300 bg-panel-strong py-1 shadow-panel">
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              disabled={item.disabled}
              onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(false); item.onClick() }}
              className={`block w-full px-3.5 py-2 text-left text-sm disabled:opacity-40 ${
                item.danger ? 'text-red-700 hover:bg-red-100' : 'text-gray-800 hover:bg-gray-100'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
