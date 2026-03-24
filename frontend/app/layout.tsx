import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Link from 'next/link'
import { ToastProvider } from '@/components/ui/Toast'
import ActiveRunsTracker from '@/components/ActiveRunsTracker'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'GenAI Customer Simulator',
  description: 'Synthetic survey respondent simulation platform',
}

function NavLink({ href, children, icon }: { href: string; children: React.ReactNode; icon: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-indigo-50 hover:text-indigo-700"
    >
      <span className="h-5 w-5 flex-shrink-0 text-gray-400">{icon}</span>
      {children}
    </Link>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-gray-50 text-gray-900 antialiased`}>
        <ToastProvider>
          <div className="flex min-h-screen">
            {/* Sidebar */}
            <aside className="fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-gray-200 bg-white">
              {/* Logo */}
              <div className="flex h-16 items-center gap-3 border-b border-gray-100 px-5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white text-sm font-bold">G</div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">GenAI Simulator</div>
                  <div className="text-xs text-gray-400">Customer Research</div>
                </div>
              </div>

              {/* Nav */}
              <nav className="flex-1 overflow-y-auto px-3 py-4">
                <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Overview</p>
                <div className="mb-4 space-y-0.5">
                  <NavLink href="/" icon={
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                    </svg>
                  }>Dashboard</NavLink>
                </div>

                <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Research</p>
                <div className="mb-4 space-y-0.5">
                  <NavLink href="/audiences" icon={
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  }>Audiences</NavLink>

                  <NavLink href="/experiments" icon={
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                  }>Experiments</NavLink>

                  <NavLink href="/analysis" icon={
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  }>Analysis</NavLink>
                </div>

                <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">System</p>
                <div className="mb-4 space-y-0.5">
                  <NavLink href="/settings" icon={
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  }>Settings</NavLink>
                </div>

                <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Docs</p>
                <div className="space-y-0.5">
                  <a
                    href="http://localhost:8000/docs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-indigo-50 hover:text-indigo-700"
                  >
                    <svg className="h-5 w-5 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                    </svg>
                    API Docs ↗
                  </a>
                </div>
              </nav>

              {/* Active runs tracker */}
              <ActiveRunsTracker />

              {/* Footer */}
              <div className="border-t border-gray-100 px-5 py-3">
                <p className="text-xs text-gray-400">v0.1.0 · Local instance</p>
              </div>
            </aside>

            {/* Main content */}
            <main className="ml-64 flex-1 overflow-auto">
              <div className="min-h-screen px-12 py-8">
                {children}
              </div>
            </main>
          </div>
        </ToastProvider>
      </body>
    </html>
  )
}
