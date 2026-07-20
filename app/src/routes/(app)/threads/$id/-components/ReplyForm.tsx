'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from '@tanstack/react-router'
import { sendReplyFn } from '../-lib/send-reply.fn'
import { dismissDraftFn } from '../-lib/dismiss-draft.fn'
import { regenerateDraftFn } from '../-lib/regenerate-draft.fn'
import { saveDraftBodyFn } from '../-lib/save-draft-body.fn'
import { DraftBanner } from './DraftBanner'
import { RegeneratePanel } from './RegeneratePanel'
import { AutoSaveBadge } from '~/routes/(app)/-components/AutoSaveBadge'
import { useAutoSave } from '~/routes/(app)/-components/useAutoSave'
import type { ConversationDetail } from '../-lib/get-conversation.fn'
import { SparkleIcon, SendIcon, XIcon, ThumbUpIcon, ThumbDownIcon, AlertTriIcon } from '~/components/ui/icons'
import { m } from '~/paraglide/messages'
import { buildTranslateUrl } from '~/lib/translate-url'

type Props = {
  conversationId: string
  conversation: ConversationDetail['conversation']
  latestDraft: ConversationDetail['latest_draft']
  latestInboundMessageId: string | null
}

export function ReplyForm({
  conversationId,
  conversation,
  latestDraft,
  latestInboundMessageId,
}: Props) {
  const router = useRouter()
  const [body, setBody] = useState(
    latestDraft?.status === 'ready' ? (latestDraft.body ?? '') : '',
  )
  const [draftStatus, setDraftStatus] = useState(latestDraft?.status ?? null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  // 005: one-off regenerate state.
  const [instruction, setInstruction] = useState('')
  const [isRegenerating, setIsRegenerating] = useState(false)
  // Snapshot of the body at the moment regenerate was triggered. Used to detect
  // success vs. failure by comparing the eventual `ready` body — though the
  // primary failure signal is the `error` column returned by getDraftStatusFn.
  const regenStartBodyRef = useRef<string>('')
  const bodyRef = useRef(body)
  const draftStatusRef = useRef(draftStatus)

  // #83: persist edits to the active ready draft so a reload restores them.
  // save returns saved:false when the server has no ready draft to write to
  // (dismissed/regenerated elsewhere) → the hook clears the badge instead of
  // claiming 保存済み. Guarded by draftStatusRef so a retry while the draft is no
  // longer ready is a no-op rather than a bogus write.
  const {
    state: saveState,
    schedule: scheduleSave,
    flush: flushSave,
    reset: resetSave,
  } = useAutoSave({
    save: async () => {
      if (draftStatusRef.current !== 'ready') return false
      const result = await saveDraftBodyFn({
        data: { conversationId, body: bodyRef.current },
      })
      return result.saved
    },
    debounceMs: 600,
  })
  // Tracks the inbound message id whose draft we've already filled into the
  // textarea, so polling re-fetches don't repeatedly overwrite or re-show it
  // (especially after the user sends a reply).
  const filledForInboundIdRef = useRef<string | null>(
    latestDraft?.status === 'ready' ? latestInboundMessageId : null,
  )

  useEffect(() => {
    bodyRef.current = body
  }, [body])

  useEffect(() => {
    draftStatusRef.current = draftStatus
  }, [draftStatus])

  // Sync latestDraft prop into local state when polling fetches a new value.
  useEffect(() => {
    if (!latestDraft) {
      if (draftStatus !== null) setDraftStatus(null)
      // No active draft to save to — any leftover badge is moot (#84).
      resetSave()
      return
    }
    if (latestDraft.status !== 'ready') {
      if (latestDraft.status !== draftStatus) setDraftStatus(latestDraft.status)
      // Draft left 'ready' (pending/failed) — the autosave target is gone, so
      // drop the badge instead of leaving a stale/dead one behind (#84).
      resetSave()
      return
    }
    if (latestInboundMessageId === filledForInboundIdRef.current) return
    setDraftStatus('ready')
    if (!bodyRef.current.trim()) {
      setBody(latestDraft.body)
    }
    // A different draft is now active — drop any leftover save badge so it can't
    // assert "保存済み" over a draft it never applied to (#84 badge staleness).
    resetSave()
    filledForInboundIdRef.current = latestInboundMessageId
  }, [latestDraft, latestInboundMessageId, draftStatus, resetSave])

  const isWindowClosed = !conversation.within_24h_window
  const hoursRemaining = conversation.hours_remaining_in_window
  const showPolicyWarning =
    hoursRemaining !== null && hoursRemaining <= 6 && hoursRemaining > 0
  const hasDraft = draftStatus === 'ready'

  const handleDraftReady = useCallback((draftBody: string) => {
    setBody(draftBody)
    setDraftStatus('ready')
    resetSave()
    // 005: regenerate success → clear instruction, re-enable button.
    setInstruction('')
    setIsRegenerating(false)
    regenStartBodyRef.current = ''
  }, [resetSave])

  // 005: handle regenerate failure / timeout from DraftBanner.
  const handleRegenerateError = useCallback(
    (reason: 'timeout' | 'regenerate_failed', message?: string) => {
      setIsRegenerating(false)
      if (reason === 'timeout') {
        setError(m.reply_draft_regenerate_timeout())
      } else {
        setError(m.reply_draft_regenerate_failed({ message: message ?? '' }))
      }
      // Restore the previous body if the textarea was empty — the worker writes
      // status='ready' on regen failure with body unchanged, so the next loader
      // refresh will repopulate it. Keep instruction populated so the operator
      // can retry without retyping.
      setDraftStatus('ready')
    },
    [],
  )

  const handleRegenerateClick = useCallback(async () => {
    if (isRegenerating) return
    // Cancel any armed/in-flight debounce save — once we regenerate, the server
    // flips the row to pending and a late save of the pre-regenerate text could
    // clobber the freshly generated draft (#84 cross-draft write).
    resetSave()
    regenStartBodyRef.current = bodyRef.current
    setIsRegenerating(true)
    setError(null)
    try {
      const result = await regenerateDraftFn({
        data: {
          conversationId,
          instruction: instruction.trim() ? instruction.trim() : undefined,
        },
      })
      if (result.ok) {
        // Server flipped row to pending → poll via DraftBanner.
        setDraftStatus('pending')
      } else {
        setIsRegenerating(false)
        if (result.error === 'enqueue_failed') {
          setError(m.reply_draft_regenerate_enqueue_failed())
        } else {
          // no_active_draft — should not normally happen because the button is
          // only visible when draft is ready. Fail soft.
          setError(m.reply_error_generic())
        }
      }
    } catch {
      setIsRegenerating(false)
      setError(m.reply_draft_regenerate_enqueue_failed())
    }
  }, [conversationId, instruction, isRegenerating, resetSave])

  const handleBodyChange = (val: string) => {
    setBody(val)
    // Nothing to persist without an active draft — the badge only renders inside
    // the ready-draft header anyway.
    if (draftStatusRef.current !== 'ready') return
    scheduleSave()
  }

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (isWindowClosed || sending || !body.trim()) return

    setSending(true)
    setError(null)

    try {
      const result = await sendReplyFn({ data: { conversationId, body } })
      if (result.ok) {
        resetSave()
        setBody('')
        setDraftStatus(null)
        setFeedback(null)
        await router.invalidate()
      } else {
        const errorMessages: Record<string, string> = {
          outside_window: m.reply_error_outside_window(),
          token_expired: m.reply_error_token_expired(),
          meta_error: m.reply_error_meta_failed(),
          validation_failed: m.reply_error_validation_failed(),
        }
        setError(errorMessages[result.error] ?? m.reply_error_generic())
      }
    } catch {
      setError(m.reply_error_send_failed())
    } finally {
      setSending(false)
    }
  }

  // Cmd+Enter shortcut
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <div style={{ padding: '0 20px 16px' }}>
      {/* Draft pending banner */}
      {draftStatus === 'pending' && (
        <DraftBanner
          conversationId={conversationId}
          initialStatus="pending"
          // 005: longer timeout when operator triggered the regenerate; default
          // 60s for auto-batch (#004 preserved UX).
          mode={isRegenerating ? 'regenerate' : 'auto'}
          onReady={handleDraftReady}
          onError={handleRegenerateError}
        />
      )}

      {/* 24h policy countdown banner */}
      {showPolicyWarning && hoursRemaining !== null && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            background: 'var(--color-amber-soft)',
            border: '1px solid oklch(0.78 0.13 75 / 0.3)',
            borderRadius: 8,
            fontSize: 12.5,
            color: 'var(--color-amber-ink)',
            marginBottom: 8,
          }}
        >
          <AlertTriIcon size={13} />
          <div>
            <strong>{m.reply_policy_countdown()}</strong>
            <span style={{ marginLeft: 6, opacity: 0.85 }}>
              {m.reply_policy_time_remaining({ hours: Math.floor(hoursRemaining), minutes: Math.floor((hoursRemaining % 1) * 60) })}
            </span>
          </div>
        </div>
      )}

      {/* 24h expired banner */}
      {isWindowClosed && (
        <p
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            background: 'var(--color-rose-soft)',
            border: '1px solid oklch(0.65 0.18 20 / 0.3)',
            borderRadius: 8,
            fontSize: 12.5,
            color: 'var(--color-rose-ink)',
            marginBottom: 8,
            margin: '0 0 8px',
          }}
        >
          {m.reply_window_closed_warning()}
        </p>
      )}

      {/* Draft composer card */}
      <div
        style={{
          background: 'var(--color-bg-raised)',
          border: '1px solid var(--color-line)',
          borderLeft: hasDraft ? '3px solid var(--color-primary)' : '1px solid var(--color-line)',
          borderRadius: 10,
          overflow: 'hidden',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        {/* Draft header (only when draft exists) */}
        {hasDraft && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px 8px',
              borderBottom: '1px solid var(--color-line)',
              background: 'var(--color-primary-soft)',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--color-primary-ink)',
              }}
            >
              <SparkleIcon size={11} />
              {m.reply_ai_suggestion_label()}
            </span>

            {/* Feedback + translate buttons */}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
              {/* 007: 下書き本文の概要把握用に Google 翻訳を新規タブで開く。
                  対象は最新の textarea 値 (body) — 編集後の文章も翻訳できる。 */}
              {body.trim() && (
                <a
                  href={buildTranslateUrl(body, 'ja')}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={m.thread_translate_aria()}
                  style={{
                    padding: '3px 6px',
                    borderRadius: 5,
                    fontSize: 11,
                    color: 'var(--color-ink-3)',
                    background: 'transparent',
                    border: '1px solid transparent',
                    textDecoration: 'none',
                    cursor: 'pointer',
                    transition: 'all 120ms',
                  }}
                >
                  {m.thread_translate_button()}
                </a>
              )}
              <button
                onClick={() => setFeedback(feedback === 'up' ? null : 'up')}
                aria-label={m.reply_feedback_good()}
                aria-pressed={feedback === 'up'}
                style={{
                  padding: '3px 6px',
                  borderRadius: 5,
                  fontSize: 11,
                  background: feedback === 'up' ? 'var(--color-green-soft)' : 'transparent',
                  color: feedback === 'up' ? 'var(--color-green-ink)' : 'var(--color-ink-3)',
                  border: feedback === 'up' ? '1px solid oklch(0.68 0.13 155 / 0.3)' : '1px solid transparent',
                  cursor: 'pointer',
                  transition: 'all 120ms',
                }}
              >
                <ThumbUpIcon size={11} />
              </button>
              <button
                onClick={() => setFeedback(feedback === 'down' ? null : 'down')}
                aria-label={m.reply_feedback_bad()}
                aria-pressed={feedback === 'down'}
                style={{
                  padding: '3px 6px',
                  borderRadius: 5,
                  fontSize: 11,
                  background: feedback === 'down' ? 'var(--color-rose-soft)' : 'transparent',
                  color: feedback === 'down' ? 'var(--color-rose-ink)' : 'var(--color-ink-3)',
                  border: feedback === 'down' ? '1px solid oklch(0.65 0.18 20 / 0.3)' : '1px solid transparent',
                  cursor: 'pointer',
                  transition: 'all 120ms',
                }}
              >
                <ThumbDownIcon size={11} />
              </button>
            </div>

            {/* Auto-save pill — real persistence (#83); error state offers retry
                (#84). Only rendered while the draft is 'ready' (the only time a
                save can target it); leaving 'ready' clears saveState below. */}
            <AutoSaveBadge state={saveState} onRetry={flushSave} />
          </div>
        )}

        {/* Textarea */}
        <div style={{ padding: '10px 14px' }}>
          <textarea
            value={body}
            onChange={(e) => handleBodyChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={m.reply_placeholder()}
            disabled={isWindowClosed || sending}
            aria-label={m.reply_body_label()}
            rows={4}
            style={{
              width: '100%',
              border: 'none',
              outline: 'none',
              resize: 'vertical',
              fontSize: 14,
              lineHeight: 1.6,
              color: 'var(--color-ink)',
              background: 'transparent',
              opacity: isWindowClosed ? 0.5 : 1,
              minHeight: 80,
            }}
          />
        </div>

        {/* Error message */}
        {error && (
          <div
            role="alert"
            style={{
              margin: '0 14px 8px',
              padding: '7px 10px',
              background: 'var(--color-rose-soft)',
              border: '1px solid oklch(0.65 0.18 20 / 0.25)',
              borderRadius: 6,
              fontSize: 12,
              color: 'var(--color-rose-ink)',
            }}
          >
            {error}
          </div>
        )}

        {/* 005: one-off regenerate panel (only when draft is ready) */}
        <div style={{ padding: '0 14px 6px' }}>
          <RegeneratePanel
            isVisible={hasDraft}
            isRegenerating={isRegenerating}
            instruction={instruction}
            onInstructionChange={setInstruction}
            onRegenerateClick={() => void handleRegenerateClick()}
          />
        </div>

        {/* Footer actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 14px 10px',
            borderTop: '1px solid var(--color-line)',
          }}
        >
          {hasDraft && (
            <button
              onClick={() => {
                resetSave()
                setBody('')
                setDraftStatus(null)
                filledForInboundIdRef.current = latestInboundMessageId
                void dismissDraftFn({ data: { conversationId } }).then(() =>
                  router.invalidate(),
                )
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '6px 10px',
                borderRadius: 7,
                fontSize: 12.5,
                fontWeight: 500,
                color: 'var(--color-ink-3)',
                background: 'transparent',
                border: '1px solid var(--color-line)',
                cursor: 'pointer',
                transition: 'all 120ms',
              }}
            >
              <XIcon size={12} />
              {m.reply_discard_button()}
            </button>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            {!isWindowClosed && (
              <span style={{ fontSize: 11, color: 'var(--color-ink-4)', fontFamily: 'var(--font-mono)' }}>
                ⌘↵
              </span>
            )}
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={isWindowClosed || sending || !body.trim()}
              aria-disabled={isWindowClosed || sending || !body.trim()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 14px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                color: 'white',
                background: isWindowClosed || !body.trim() ? 'var(--color-ink-4)' : 'var(--color-primary)',
                cursor: isWindowClosed || sending || !body.trim() ? 'not-allowed' : 'pointer',
                opacity: sending ? 0.7 : 1,
                transition: 'background 120ms, opacity 120ms',
              }}
            >
              <SendIcon size={12} />
              {sending ? m.reply_sending_button() : m.reply_send_button()}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
