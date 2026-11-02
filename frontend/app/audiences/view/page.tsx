'use client'
import { Suspense } from 'react'
import { PageSpinner } from '@/components/ui/Spinner'
import { AudienceDetail } from './AudienceDetail'

// Static export: the id comes from the query string (?id=…), which needs a Suspense boundary.
export default function Page() {
  return <Suspense fallback={<PageSpinner />}><AudienceDetail /></Suspense>
}
