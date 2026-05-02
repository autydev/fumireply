'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { sendReplyFn } from '../-lib/send-reply.fn'
import { DraftBanner } from './DraftBanner'
import type { ConversationDetail } from '../-lib/get-conversation.fn'
import { SparkleIcon, SendIcon, XIcon, ThumbUpIcon, ThumbDownIcon, AlertTriIcon } from '~/components/ui/icons'

type Props = {
  conversationId: string
  conversation: ConversationDetail['conversation']
  latestDraft: ConversationDetail['latest_draft']
  latestInboundMessageId: string | null
}

type AutoSaveState = 'editing' | 'saving' | 'saved'

export function ReplyForm({
  conversationId,
  conversation,
  latestDraft,
  latestInboundMessageId,
}: Props) {
  const [body, setBody] = useState(
    latestDraft?.status === 'ready' ? (latestDraft.body ?? '') : '',
  )
  const [draftStatus, setDraftStatus] = useState(latestDraft?.status ?? null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<AutoSaveState>('saved')
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isWindowClosed = !conversation.within_24h_window
  const hoursRemaining = conversation.hours_remaining_in_window
  const showPolicyWarning =
    hoursRemaining !== null && hoursRemaining <= 6 && hoursRemaining > 0
  const hasDraft = latestDraft !== null && latestDraft.status === 'ready'

  const handleDraftReady = useCallback((draftBody: string) => {
    setBody(draftBody)
    setDraftStatus('ready')
  }, [])

  const handleBodyChange = (val: string) => {
    setBody(val)
    setSaveState('editing')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      setSaveState('saving')
      setTimeout(() => setSaveState('saved'), 450)
    }, 600)
  }

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (isWindowClosed || sending || !body.trim()) return

    setSending(true)
    setError(null)

    try {
      const result = await sendReplyFn({ data: { conversationId, body } })
      if (result.ok) {
        setBody('')
        setDraftStatus(null)
        setFeedback(null)
        setSaveState('saved')
      } else {
        const errorMessages: Record<string, string> = {
          outside_window: '24時間窓が閉じています。返信できません。',
          token_expired: 'ページアクセストークンが失効しています。管理者に連絡してください。',
          meta_error: 'Metaへの送信に失敗しました。しばらく待ってから再試行してください。',
          validation_failed: '入力内容が不正です。',
        }
        setError(errorMessages[result.error] ?? '送信に失敗しました。')
      }
    } catch {
      setError('送信中にエラーが発生しました。')
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
      {latestInboundMessageId && draftStatus === 'pending' && (
        <DraftBanner
          messageId={latestInboundMessageId}
          initialStatus="pending"
          onReady={handleDraftReady}
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
            <strong>Meta 24時間ポリシー · 返信期限迫る</strong>
            <span style={{ marginLeft: 6, opacity: 0.85 }}>
              残り {Math.floor(hoursRemaining)}h {Math.floor((hoursRemaining % 1) * 60)}m
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
          24時間窓が閉じているため返信できません。
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
              Claude ドラフト
            </span>

            {/* Feedback buttons */}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <button
                onClick={() => setFeedback(feedback === 'up' ? null : 'up')}
                title="このドラフトは良い"
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
                title="このドラフトは悪い"
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

            {/* Auto-save pill */}
            {saveState === 'saving' && (
              <span style={{ fontSize: 11, color: 'var(--color-ink-3)', fontFamily: 'var(--font-mono)' }}>
                保存中…
              </span>
            )}
            {saveState === 'saved' && body !== (latestDraft?.body ?? '') && (
              <span style={{ fontSize: 11, color: 'var(--color-green-ink)', fontFamily: 'var(--font-mono)' }}>
                下書き保存済
              </span>
            )}
          </div>
        )}

        {/* Textarea */}
        <div style={{ padding: '10px 14px' }}>
          <textarea
            value={body}
            onChange={(e) => handleBodyChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="返信を入力してください"
            disabled={isWindowClosed || sending}
            aria-label="返信本文"
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
                setBody('')
                setDraftStatus(null)
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
              破棄
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
              {sending ? '送信中…' : '送信'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
