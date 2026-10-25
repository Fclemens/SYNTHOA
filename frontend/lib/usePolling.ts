import { useCallback, useEffect, useRef } from 'react'

interface PollingOptions {
  /** Delay between polls while `poll` reports activity (returns true). */
  intervalMs: number
  /** Delay once `poll` reports no activity; omit to stop polling until kick(). */
  idleIntervalMs?: number
  /** Run `poll` once as soon as the hook starts. */
  immediate?: boolean
  /** Polling is paused while false. */
  enabled?: boolean
}

/**
 * Repeatedly calls `poll` while it returns true (something is still running).
 * Skips ticks while the tab is hidden, never overlaps calls, and returns
 * kick() to poll right away — e.g. after the user starts a job.
 * Polling restarts when `key` changes.
 */
export function usePolling(
  poll: () => Promise<boolean>,
  { intervalMs, idleIntervalMs, immediate = false, enabled = true }: PollingOptions,
  key: unknown = null,
): () => void {
  const pollRef = useRef(poll)
  pollRef.current = poll
  const kickRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight = false

    const schedule = (delay: number | undefined) => {
      if (timer) clearTimeout(timer)
      timer = alive && delay !== undefined ? setTimeout(tick, delay) : null
    }

    async function tick() {
      if (!alive || inFlight) return
      if (document.hidden) return schedule(intervalMs)
      inFlight = true
      let active = true
      try {
        active = await pollRef.current()
      } catch {
        active = true   // transient error (backend restarting) — keep trying
      } finally {
        inFlight = false
      }
      schedule(active ? intervalMs : idleIntervalMs)
    }

    kickRef.current = () => { tick() }
    if (immediate) tick()
    else schedule(intervalMs)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      kickRef.current = () => {}
    }
  }, [enabled, immediate, intervalMs, idleIntervalMs, key])

  return useCallback(() => kickRef.current(), [])
}
