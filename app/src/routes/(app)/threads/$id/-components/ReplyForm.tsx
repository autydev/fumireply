'use client'

import { useState, useCallback } from 'react'
import { sendReplyFn } from '../-lib/send-reply.fn'
import { DraftBanner } from './DraftBanner'
import type { ConversationDetail } from '../-lib/get-conversation.fn'

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
  const [body, setBody] = useState(
    latestDraft?.status === 'ready' ? (latestDraft.body ?? '') : '',
  )
  const [draftStatus, setDraftStatus] = useState(latestDraft?.status ?? null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDraftReady = useCallback((draftBody: string) => {
    setBody(draftBody)
    setDraftStatus('ready')
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!conversation.within_24h_window || sending || !body.trim()) return

    setSending(true)
    setError(null)

    try {
      const result = await sendReplyFn({ data: { conversationId, body } })
      if (result.ok) {
        setBody('')
        setDraftStatus(null)
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

  const isWindowClosed = !conversation.within_24h_window

  return (
    <div className="reply-form-container">
      {latestInboundMessageId && draftStatus === 'pending' && (
        <DraftBanner
          messageId={latestInboundMessageId}
          initialStatus="pending"
          onReady={handleDraftReady}
        />
      )}

      {conversation.within_24h_window && conversation.hours_remaining_in_window !== null && (
        <p className="window-remaining">
          24h窓残り: {conversation.hours_remaining_in_window.toFixed(1)}時間
        </p>
      )}

      {isWindowClosed && (
        <p className="window-closed-notice" role="alert">
          24時間窓が閉じているため返信できません。
        </p>
      )}

      <form onSubmit={handleSubmit}>
        <textarea
          className="reply-textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="返信を入力してください"
          disabled={isWindowClosed || sending}
          aria-label="返信本文"
        />

        {error && (
          <p className="reply-error" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={isWindowClosed || sending || !body.trim()}
          aria-disabled={isWindowClosed || sending || !body.trim()}
        >
          {sending ? '送信中…' : '送信'}
        </button>
      </form>
    </div>
  )
}
