'use client'

import { useEffect, useRef, useState } from 'react'
import { getDraftStatusFn } from '../-lib/get-draft-status.fn'
import { SparkleIcon } from '~/components/ui/icons'
import { m } from '~/paraglide/messages'

const POLL_INTERVAL_MS = 3000
// Default auto-batch ceiling (#004 UX preserved).
const MAX_POLL_MS = 60_000
// 005: operator-initiated regenerate gets a longer window. Spec FR-011 → 90s.
// Scoped to `mode === 'regenerate'` so the auto-batch path is unaffected.
const REGENERATE_MAX_POLL_MS = 90_000

type Mode = 'auto' | 'regenerate'
type ErrorReason = 'timeout' | 'regenerate_failed'

export function DraftBanner({
  conversationId,
  initialStatus,
  mode = 'auto',
  onReady,
  onError,
}: {
  conversationId: string
  initialStatus: 'pending' | 'ready' | 'failed'
  // 005: which timeout policy to use for this banner instance.
  mode?: Mode
  onReady: (body: string) => void
  // 005: failure / timeout signal so the parent can show a toast and re-enable
  // the regenerate button.
  onError?: (reason: ErrorReason, message?: string) => void
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

    const activeTimeoutMs = mode === 'regenerate' ? REGENERATE_MAX_POLL_MS : MAX_POLL_MS

    const stopPolling = () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      isActiveRef.current = false
    }

    const poll = async () => {
      if (!isActiveRef.current) return

      if (Date.now() - startTimeRef.current > activeTimeoutMs) {
        stopPolling()
        setVisible(false)
        onError?.('timeout')
        return
      }

      try {
        const result = await getDraftStatusFn({ data: { conversationId } })
        if (!isActiveRef.current) return
        if (result.status === 'ready') {
          stopPolling()
          // 005: ready + non-null error = regenerate failed; body is the
          // pre-regenerate text (worker did not overwrite it). Surface the
          // failure to the parent so it can toast + keep instruction populated.
          if (result.error != null) {
            setVisible(false)
            onError?.('regenerate_failed', result.error)
            return
          }
          if (result.body !== null) onReady(result.body)
          setVisible(false)
        } else if (result.status === 'failed') {
          // Auto-batch failure path (#004 behavior). No error toast here — the
          // banner just disappears.
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
  }, [conversationId, initialStatus, mode, onReady, onError])

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
      {m.reply_draft_generating()}
    </div>
  )
}
