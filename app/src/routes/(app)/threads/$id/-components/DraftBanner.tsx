'use client'

import { useEffect, useRef, useState } from 'react'
import { getDraftStatusFn } from '../-lib/get-draft-status.fn'

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
  const [visible, setVisible] = useState(initialStatus === 'pending')
  const startTimeRef = useRef(Date.now())
  const isActiveRef = useRef(initialStatus === 'pending')

  useEffect(() => {
    if (initialStatus !== 'pending') return

    const poll = async () => {
      if (!isActiveRef.current) return

      if (Date.now() - startTimeRef.current > MAX_POLL_MS) {
        isActiveRef.current = false
        setVisible(false)
        return
      }

      try {
        const result = await getDraftStatusFn({ data: { messageId } })
        if (result.status === 'ready') {
          isActiveRef.current = false
          if (result.body) onReady(result.body)
          setVisible(false)
        } else if (result.status === 'failed') {
          isActiveRef.current = false
          setVisible(false)
        }
      } catch {
        // silent — keep polling
      }
    }

    const id = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)

    return () => {
      clearInterval(id)
      isActiveRef.current = false
    }
  }, [messageId, initialStatus, onReady])

  if (!visible) return null

  return (
    <div className="draft-banner" role="status" aria-live="polite">
      下書き生成中…
    </div>
  )
}
