import { useSearchParams } from 'next/navigation'

/**
 * Detail pages take their id from the query string, so the frontend can be a
 * static export served by the backend (the desktop app) with no Node server.
 */
export const routes = {
  audience: (id: string) => `/audiences/view?id=${id}`,
  experiment: (id: string, tab?: string) => `/experiments/view?id=${id}${tab ? `&tab=${tab}` : ''}`,
  run: (id: string) => `/runs/view?id=${id}`,
  results: (id: string) => `/analysis/view?id=${id}`,
}

export function useIdParam(): string {
  return useSearchParams().get('id') ?? ''
}
