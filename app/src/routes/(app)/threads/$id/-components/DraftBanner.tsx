'use client'

import { useEffect, useRef, useState } from 'react'
import { getDraftStatusFn } from '../-lib/get-draft-status.fn'
import { SparkleIcon } from '~/components/ui/icons'

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
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    setVisible(initialStatus === 'pending')
    startTimeRef.current = Date.now()
    isActiveRef.current = initialStatus === 'pending'

    if (initialStatus !== 'pending') return

    const stopPolling = () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      isActiveRef.current = false
    }

    const poll = async () => {
      if (!isActiveRef.current) return

      if (Date.now() - startTimeRef.current > MAX_POLL_MS) {
        stopPolling()
        setVisible(false)
        return
      }

      try {
        const result = await getDraftStatusFn({ data: { messageId } })
        if (!isActiveRef.current) return
        if (result.status === 'ready') {
          stopPolling()
          if (result.body !== null) onReady(result.body)
          setVisible(false)
        } else if (result.status === 'failed') {
          stopPolling()
          setVisible(false)
        }
      } catch {
        // keep polling
      }
    }

    intervalRef.current = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)

    return () => {
      stopPolling()
    }
  }, [messageId, initialStatus, onReady])

  if (!visible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        background: 'var(--color-primary-soft)',
        border: '1px solid oklch(0.55 0.16 265 / 0.2)',
        borderRadius: 10,
        fontSize: 12.5,
        color: 'var(--color-primary-ink)',
        fontWeight: 500,
        margin: '0 0 8px',
      }}
    >
      <SparkleIcon size={12} />
      下書き生成中…
    </div>
  )
}
