interface ProgressBarProps {
  value: number   // 0–100
  color?: 'indigo' | 'green' | 'yellow' | 'red'
  showLabel?: boolean
  size?: 'sm' | 'md'
}

const colors = {
  indigo: 'bg-indigo-500',
  green:  'bg-green-500',
  yellow: 'bg-yellow-500',
  red:    'bg-red-500',
}

const heights = { sm: 'h-1.5', md: 'h-2.5' }

export function ProgressBar({ value, color = 'indigo', showLabel, size = 'md' }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, value))
  return (
    <div className="flex items-center gap-3">
      <div className={`flex-1 overflow-hidden rounded-full bg-gray-200 ${heights[size]}`}>
        <div
          className={`${heights[size]} rounded-full transition-all duration-300 ${colors[color]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && <span className="w-10 text-right text-xs text-gray-500">{pct.toFixed(0)}%</span>}
    </div>
  )
}
