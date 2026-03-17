'use client'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

interface PruneRunsModalProps {
  open: boolean
  onClose: () => void
  onConfirm: (includeCompleted: boolean) => void
  loading: boolean
  counts: { failed: number; cancelled: number; completed: number }
}

export function PruneRunsModal({ open, onClose, onConfirm, loading, counts }: PruneRunsModalProps) {
  const incompleteTotal = counts.failed + counts.cancelled
  const allTotal = incompleteTotal + counts.completed

  return (
    <Modal open={open} onClose={onClose} title="Prune Runs" size="sm">
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Permanently delete finished runs and all their tasks.
          Running and pending runs are never affected.
        </p>

        <div className="space-y-3">
          {/* Option A: failed + cancelled only */}
          <button
            disabled={loading || incompleteTotal === 0}
            onClick={() => onConfirm(false)}
            className="w-full rounded-xl border-2 border-gray-200 p-4 text-left transition-colors hover:border-orange-300 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-gray-900">Incomplete &amp; cancelled</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  Failed and cancelled runs only — completed results are kept
                </p>
                {(counts.failed > 0 || counts.cancelled > 0) && (
                  <p className="mt-1 text-xs text-orange-600">
                    {counts.failed > 0 && `${counts.failed} failed`}
                    {counts.failed > 0 && counts.cancelled > 0 && ' · '}
                    {counts.cancelled > 0 && `${counts.cancelled} cancelled`}
                  </p>
                )}
              </div>
              <span className="flex-shrink-0 rounded-full bg-orange-100 px-2.5 py-1 text-sm font-semibold text-orange-700">
                {incompleteTotal}
              </span>
            </div>
          </button>

          {/* Option B: everything incl. completed */}
          <button
            disabled={loading || allTotal === 0}
            onClick={() => onConfirm(true)}
            className="w-full rounded-xl border-2 border-gray-200 p-4 text-left transition-colors hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-gray-900">All finished runs</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  Also removes completed runs — export any results first
                </p>
                {counts.completed > 0 && (
                  <p className="mt-1 text-xs text-red-500">
                    {counts.completed} completed will also be deleted
                  </p>
                )}
              </div>
              <span className="flex-shrink-0 rounded-full bg-red-100 px-2.5 py-1 text-sm font-semibold text-red-700">
                {allTotal}
              </span>
            </div>
          </button>
        </div>

        {loading && (
          <p className="text-center text-xs text-gray-400">Deleting…</p>
        )}

        <div className="flex justify-end pt-1">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Go back
          </Button>
        </div>
      </div>
    </Modal>
  )
}
