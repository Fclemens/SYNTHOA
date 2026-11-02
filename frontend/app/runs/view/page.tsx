'use client'
import { Suspense } from 'react'
import { PageSpinner } from '@/components/ui/Spinner'
import { RunDetail } from './RunDetail'

// Static export: the id comes from the query string (?id=…), which needs a Suspense boundary.
export default function Page() {
  return <Suspense fallback={<PageSpinner />}><RunDetail /></Suspense>
}
