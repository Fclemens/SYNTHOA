'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import ActiveRunsTracker from '@/components/ActiveRunsTracker'
import { BASE } from '@/lib/api'
import { Brand } from './Brand'

const icon = (d: string | string[]) => (
  <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    {(Array.isArray(d) ? d : [d]).map(p => <path key={p} strokeLinecap="round" strokeLinejoin="round" d={p} />)}
  </svg>
)

const NAV: { section: string; items: { href: string; label: string; icon: React.ReactNode }[] }[] = [
  { section: 'Overview', items: [
    { href: '/', label: 'Dashboard', icon: icon('M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6') },
  ] },
  { section: 'Research', items: [
    { href: '/audiences', label: 'Audiences', icon: icon('M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z') },
    { href: '/experiments', label: 'Experiments', icon: icon('M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2') },
    { href: '/analysis', label: 'Analysis', icon: icon('M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z') },
  ] },
  { section: 'System', items: [
    { href: '/settings', label: 'Settings', icon: icon(['M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z', 'M15 12a3 3 0 11-6 0 3 3 0 016 0z']) },
  ] },
]

const STORAGE_KEY = 'synthoa.sidebar.collapsed'

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(STORAGE_KEY) === '1') } catch { /* storage unavailable */ }
  }, [])

  function toggle() {
    setCollapsed(c => {
      try { localStorage.setItem(STORAGE_KEY, c ? '0' : '1') } catch { /* storage unavailable */ }
      return !c
    })
  }

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href))
    || (href === '/analysis' && pathname.startsWith('/runs'))
  const width = collapsed ? 'w-[76px]' : 'w-64'

  return (
    <div className="flex min-h-screen">
      <aside className={`glass fixed inset-y-3 left-3 z-40 flex ${width} flex-col rounded-2xl transition-[width] duration-200`}>
        <div className={`flex h-16 items-center ${collapsed ? 'justify-center' : 'justify-between px-4'}`}>
          <Link href="/" title="Synthoa"><Brand compact={collapsed} /></Link>
          {!collapsed && (
            <button onClick={toggle} title="Collapse sidebar" className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" /></svg>
            </button>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-2">
          {NAV.map(group => (
            <div key={group.section} className="mb-4">
              {!collapsed && <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-gray-500">{group.section}</p>}
              <div className="space-y-0.5">
                {group.items.map(item => {
                  const active = isActive(item.href)
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={collapsed ? item.label : undefined}
                      aria-current={active ? 'page' : undefined}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${collapsed ? 'justify-center' : ''} ${
                        active
                          ? 'border border-indigo-300 bg-indigo-100 text-gray-900'
                          : 'border border-transparent text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                      }`}
                    >
                      <span className={active ? 'text-indigo-400' : 'text-gray-500'}>{item.icon}</span>
                      {!collapsed && item.label}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
          {!collapsed && (
            <a
              href={`${BASE}/docs`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex items-center gap-3 rounded-lg px-3 py-2 text-xs text-gray-500 hover:text-gray-900"
            >
              API docs ↗
            </a>
          )}
        </nav>

        {!collapsed && <ActiveRunsTracker />}

        <div className={`border-t border-gray-100 py-3 ${collapsed ? 'flex justify-center' : 'px-5'}`}>
          {collapsed ? (
            <button onClick={toggle} title="Expand sidebar" className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>
            </button>
          ) : (
            <p className="text-[11px] text-gray-500">v0.3.0 · Local instance</p>
          )}
        </div>
      </aside>

      <main className={`flex-1 transition-[margin] duration-200 ${collapsed ? 'ml-[92px]' : 'ml-[272px]'}`}>
        <div className="mx-auto min-h-screen max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  )
}
