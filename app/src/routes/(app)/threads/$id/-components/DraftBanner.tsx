'use client'

import { useEffect, useRef } from 'react'
import { getDraftStatusFn } from '../-lib/get-draft-status.fn'
import type { DraftStatus } from '../-lib/get-draft-status.fn'

const POLL_INTERVAL_MS = 3000
const MAX_POLL_MS = 60_000

export function DraftBanner({
  messageId,
  initialStatus,
  onReady,
}: {
  messageId: string
  initialStatus: 'pending' | 'ready' | 'failed'
  onReady: (body: string) => void
}) {
  const startTimeRef = useRef(Date.now())
  const statusRef = useRef(initialStatus)

  useEffect(() => {
    if (initialStatus !== 'pending') return

    const poll = async () => {
      if (statusRef.current !== 'pending') return
      if (Date.now() - startTimeRef.current > MAX_POLL_MS) return

      let result: DraftStatus
      try {
        result = await getDraftStatusFn({ data: { messageId } })
      } catch {
        return
      }

      statusRef.current = result.status
      if (result.status === 'ready' && result.body) {
        onReady(result.body)
      }
    }

    const id = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)

    return () => clearInterval(id)
  }, [messageId, initialStatus, onReady])

  if (initialStatus !== 'pending') return null

  return (
    <div className="draft-banner" role="status" aria-live="polite">
      下書き生成中…
    </div>
  )
}
