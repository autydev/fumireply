import { useCallback, useEffect, useState } from 'react'
import type { ConversationDetail } from '../-lib/get-conversation.fn'
import { CustomerPanelHeader } from './CustomerPanelHeader'
import { AiPersonaSummary } from './AiPersonaSummary'
import { DraftSettingsEditor } from './DraftSettingsEditor'
import { InternalNoteEditor } from './InternalNoteEditor'
import { XIcon } from '~/components/ui/icons'
import { m } from '~/paraglide/messages'

interface CustomerPanelProps {
  conversation: ConversationDetail['conversation']
  isOpen: boolean
  onClose: () => void
}

// At/above this width the panel is a docked column; below it is an on-demand
// overlay (see the .customer-panel rules in styles.css). The two breakpoints
// must stay in sync (CSS overlay = max-width 1279px → desktop = min-width 1280px).
const DESKTOP_QUERY = '(min-width: 1280px)'

export function useCustomerPanelOpen() {
  // SSR-safe: start closed so the first paint never covers the thread on mobile.
  // After mount, default open on desktop (docked) and closed on narrow screens
  // (overlay). State is per-session and NOT persisted — so closing the mobile
  // overlay can never leave the desktop panel hidden, and vice versa.
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(DESKTOP_QUERY)
    const apply = () => setIsOpen(mql.matches)
    apply()
    // Re-sync when the viewport crosses the breakpoint (device rotation,
    // devtools emulation, window resize). Without this a desktop-opened panel
    // becomes a full-screen overlay covering the thread on mobile, and a
    // mobile-closed panel becomes unreachable on desktop (toggle is hidden
    // ≥1280px). Crossing resets to that mode's default (#80).
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [])

  const toggle = useCallback(() => setIsOpen((prev) => !prev), [])

  return { isOpen, toggle }
}

export function CustomerPanel({ conversation, isOpen, onClose }: CustomerPanelProps) {
  return (
    <div
      className={`customer-panel${isOpen ? ' customer-panel--open' : ' customer-panel--hidden'}`}
      aria-hidden={!isOpen}
    >
      <div
        style={{
          height: '100%',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Mobile-only close bar — on narrow screens the panel is a full-height
            overlay covering the thread header's toggle, so it needs its own close. */}
        <button
          type="button"
          className="customer-panel__close"
          onClick={onClose}
          aria-label={m.cp_toggle_hide()}
          style={{
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 6,
            padding: '10px 14px',
            borderBottom: '1px solid var(--color-line)',
            background: 'var(--color-bg-raised)',
            color: 'var(--color-ink-2)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          <XIcon size={15} />
          <span>{m.cp_toggle_hide()}</span>
        </button>
        <CustomerPanelHeader
          conversationId={conversation.id}
          customerName={conversation.customer_name}
          customerPsid={conversation.customer_psid}
        />
        <div style={{ borderBottom: '1px solid var(--color-line)' }}>
          {/* Read-only display: updated server-side by the summary job, so it
              keeps following polled loader data — unlike the editors below. */}
          <AiPersonaSummary
            summary={conversation.summary}
            lastSummarizedAt={conversation.last_summarized_at}
          />
        </div>
        <div style={{ borderBottom: '1px solid var(--color-line)' }}>
          {/* key: reset editor state only when switching conversations — polled
              refetches must never overwrite in-progress input (#72). */}
          <DraftSettingsEditor
            key={conversation.id}
            conversationId={conversation.id}
            tonePreset={conversation.tone_preset}
            customPrompt={conversation.custom_prompt}
          />
        </div>
        <InternalNoteEditor
          key={conversation.id}
          conversationId={conversation.id}
          note={conversation.note}
        />
      </div>
    </div>
  )
}
