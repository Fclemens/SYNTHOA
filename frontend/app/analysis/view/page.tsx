'use client'
import { Suspense } from 'react'
import { PageSpinner } from '@/components/ui/Spinner'
import { ResultsDetail } from './ResultsDetail'

// Static export: the id comes from the query string (?id=…), which needs a Suspense boundary.
export default function Page() {
  return <Suspense fallback={<PageSpinner />}><ResultsDetail /></Suspense>
}
