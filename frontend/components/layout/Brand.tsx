/** App mark + name, in the same style as fclementi's other apps (Forecaster, STT Wizard). */
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <div
      className="grid flex-none place-items-center rounded-[9px] bg-accent"
      style={{ width: size, height: size, boxShadow: '0 4px 18px rgba(124, 58, 237, 0.45)' }}
      aria-hidden="true"
    >
      {/* A small panel of personas: one in front, two behind */}
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 18 18" fill="none">
        <circle cx="4" cy="6.6" r="1.9" fill="white" fillOpacity="0.6" />
        <circle cx="14" cy="6.6" r="1.9" fill="white" fillOpacity="0.6" />
        <path d="M0.8 13.6a3.3 3.3 0 0 1 5.6-2.4M17.2 13.6a3.3 3.3 0 0 0-5.6-2.4" stroke="white" strokeOpacity="0.6" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="9" cy="5.4" r="2.6" fill="white" />
        <path d="M4.6 15.6a4.4 4.4 0 0 1 8.8 0" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </div>
  )
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark />
      {!compact && (
        <div className="flex flex-col leading-tight">
          <span className="text-[15px] font-bold tracking-[0.06em] text-gray-900">SYNTHOA</span>
          <span className="text-[11px] tracking-[0.02em] text-gray-500">
            by <b className="font-medium text-indigo-400">fclementi</b>
          </span>
        </div>
      )}
    </div>
  )
}
