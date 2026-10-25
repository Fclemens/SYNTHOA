import Link from 'next/link'

export interface Crumb { label: string; href?: string }

/** "Experiments › E-bike pricing › Run #2" — replaces the per-page "← Back" links. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1.5 text-sm text-gray-500">
      {items.map((c, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-gray-400">›</span>}
          {c.href ? (
            <Link href={c.href} className="hover:text-indigo-400">{c.label}</Link>
          ) : (
            <span className="text-gray-700">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}
