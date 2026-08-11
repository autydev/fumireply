'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from '@tanstack/react-router'
import { sendReplyFn } from '../-lib/send-reply.fn'
import { createUploadUrlFn } from '../-lib/create-upload-url.fn'
import { dismissDraftFn } from '../-lib/dismiss-draft.fn'
import { regenerateDraftFn } from '../-lib/regenerate-draft.fn'
import { DraftBanner } from './DraftBanner'
import { RegeneratePanel } from './RegeneratePanel'
import type { ConversationDetail } from '../-lib/get-conversation.fn'
import { SparkleIcon, SendIcon, XIcon, ImageIcon, ThumbUpIcon, ThumbDownIcon, AlertTriIcon } from '~/components/ui/icons'
import { ALLOWED_IMAGE_TYPES, MAX_ATTACHMENT_BYTES, isAllowedImageType } from '~/lib/media-constants'
import { m } from '~/paraglide/messages'
import { buildTranslateUrl } from '~/lib/translate-url'

type Props = {
  conversationId: string
  conversation: ConversationDetail['conversation']
  latestDraft: ConversationDetail['latest_draft']
  latestInboundMessageId: string | null
  mediaUploadEnabled: boolean
}

type AutoSaveState = 'editing' | 'saving' | 'saved'

// 010: 添付の状態機械。idle → picked (client 検証済み) → uploading → ready。
type UploadState = 'idle' | 'picked' | 'uploading' | 'ready'
type Attachment = {
  file: File
  previewUrl: string
  contentType: (typeof ALLOWED_IMAGE_TYPES)[number]
  s3Key: string | null // ready のときのみ非 null
}

export function ReplyForm({
  conversationId,
  conversation,
  latestDraft,
  latestInboundMessageId,
  mediaUploadEnabled,
}: Props) {
  const router = useRouter()
  const [body, setBody] = useState(
    latestDraft?.status === 'ready' ? (latestDraft.body ?? '') : '',
  )
  const [draftStatus, setDraftStatus] = useState(latestDraft?.status ?? null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 010: 添付 (画像) 状態
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [saveState, setSaveState] = useState<AutoSaveState>('saved')
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  // 005: one-off regenerate state.
  const [instruction, setInstruction] = useState('')
  const [isRegenerating, setIsRegenerating] = useState(false)
  // Snapshot of the body at the moment regenerate was triggered. Used to detect
  // success vs. failure by comparing the eventual `ready` body — though the
  // primary failure signal is the `error` column returned by getDraftStatusFn.
  const regenStartBodyRef = useRef<string>('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveInnerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bodyRef = useRef(body)
  // Tracks the inbound message id whose draft we've already filled into the
  // textarea, so polling re-fetches don't repeatedly overwrite or re-show it
  // (especially after the user sends a reply).
  const filledForInboundIdRef = useRef<string | null>(
    latestDraft?.status === 'ready' ? latestInboundMessageId : null,
  )

  useEffect(() => {
    bodyRef.current = body
  }, [body])

  // Sync latestDraft prop into local state when polling fetches a new value.
  useEffect(() => {
    if (!latestDraft) {
      if (draftStatus !== null) setDraftStatus(null)
      return
    }
    if (latestDraft.status !== 'ready') {
      if (latestDraft.status !== draftStatus) setDraftStatus(latestDraft.status)
      return
    }
    if (latestInboundMessageId === filledForInboundIdRef.current) return
    setDraftStatus('ready')
    if (!bodyRef.current.trim()) {
      setBody(latestDraft.body)
    }
    filledForInboundIdRef.current = latestInboundMessageId
  }, [latestDraft, latestInboundMessageId, draftStatus])

  const isWindowClosed = !conversation.within_24h_window
  const hoursRemaining = conversation.hours_remaining_in_window
  const showPolicyWarning =
    hoursRemaining !== null && hoursRemaining <= 6 && hoursRemaining > 0
  const hasDraft = draftStatus === 'ready'
  // 010: 送信可否。テキストも添付も無いときだけ不可 (§7 の M-3 緩和)。
  const hasReadyAttachment = attachment?.s3Key != null && uploadState === 'ready'
  const showAttachButton = mediaUploadEnabled && !isWindowClosed
  const sendDisabled =
    isWindowClosed || sending || uploadState === 'uploading' || (!body.trim() && !hasReadyAttachment)

  const handleDraftReady = useCallback((draftBody: string) => {
    setBody(draftBody)
    setDraftStatus('ready')
    // 005: regenerate success → clear instruction, re-enable button.
    setInstruction('')
    setIsRegenerating(false)
    regenStartBodyRef.current = ''
  }, [])

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
  }, [conversationId, instruction, isRegenerating])

  const handleBodyChange = (val: string) => {
    setBody(val)
    setSaveState('editing')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (saveInnerTimer.current) clearTimeout(saveInnerTimer.current)
    saveTimer.current = setTimeout(() => {
      setSaveState('saving')
      saveInnerTimer.current = setTimeout(() => setSaveState('saved'), 450)
    }, 600)
  }

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (saveInnerTimer.current) clearTimeout(saveInnerTimer.current)
    }
  }, [])

  // 010: 進行中アップロードの識別子。取り消し/差し替えでインクリメントして
  // in-flight のアップロードを無効化する (完了後の setAttachment 復活を防ぐ)。
  const uploadSeqRef = useRef(0)

  // 010: 添付をクリアしてプレビュー URL を revoke する。アップロード中でも呼べる —
  // uploadSeq を進めることで in-flight の完了ハンドラが状態を書き戻さなくなる。
  const clearAttachment = useCallback(() => {
    uploadSeqRef.current += 1
    setAttachment((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl)
      return null
    })
    setUploadState('idle')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  // アンマウント時にプレビュー URL を revoke (リーク防止)。previewUrl が変わったら
  // 前の URL を解放する。
  const prevPreviewUrlRef = useRef<string | null>(null)
  useEffect(() => {
    const current = attachment?.previewUrl ?? null
    const prev = prevPreviewUrlRef.current
    if (prev && prev !== current) URL.revokeObjectURL(prev)
    prevPreviewUrlRef.current = current
    return () => {
      if (current) URL.revokeObjectURL(current)
    }
  }, [attachment?.previewUrl])

  // 010: ファイル選択 → client 検証 → S3 直接アップロード。
  const handlePickFile = useCallback(
    async (file: File) => {
      setError(null)
      // client 検証 (正はサーバー — §7)。外れは即エラーでアップロードに進まない。
      if (!isAllowedImageType(file.type)) {
        setError(m.thread_attach_invalid_type())
        return
      }
      if (file.size > MAX_ATTACHMENT_BYTES || file.size === 0) {
        setError(m.thread_attach_too_large())
        return
      }

      const previewUrl = URL.createObjectURL(file)
      const contentType = file.type as (typeof ALLOWED_IMAGE_TYPES)[number]
      const mySeq = ++uploadSeqRef.current
      // このアップロードが取り消し/差し替えされたか。true なら state を書き戻さず previewUrl だけ解放。
      const superseded = () => uploadSeqRef.current !== mySeq
      const abort = (msg?: string) => {
        URL.revokeObjectURL(previewUrl)
        if (superseded()) return // 既に別操作が state を握っている
        if (msg) setError(msg)
        setAttachment(null)
        setUploadState('idle')
      }

      setAttachment({ file, previewUrl, contentType, s3Key: null })
      setUploadState('uploading')

      try {
        const issued = await createUploadUrlFn({
          data: { conversationId, contentType, sizeBytes: file.size },
        })
        if (superseded()) {
          URL.revokeObjectURL(previewUrl)
          return
        }
        if (!issued.ok) {
          const messages: Record<string, string> = {
            outside_window: m.reply_error_outside_window(),
          }
          abort(messages[issued.error] ?? m.thread_attach_upload_failed())
          return
        }

        const putRes = await fetch(issued.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': contentType },
          body: file,
        })
        if (superseded()) {
          URL.revokeObjectURL(previewUrl)
          return
        }
        if (!putRes.ok) {
          abort(m.thread_attach_upload_failed())
          return
        }

        setAttachment({ file, previewUrl, contentType, s3Key: issued.s3Key })
        setUploadState('ready')
      } catch {
        abort(m.thread_attach_upload_failed())
      }
    },
    [conversationId],
  )

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const hasReadyAttachment = attachment?.s3Key != null && uploadState === 'ready'
    if (isWindowClosed || sending || uploadState === 'uploading') return
    if (!body.trim() && !hasReadyAttachment) return

    setSending(true)
    setError(null)

    try {
      const result = await sendReplyFn({
        data: {
          conversationId,
          body,
          ...(hasReadyAttachment ? { attachment: { s3Key: attachment!.s3Key! } } : {}),
        },
      })
      if (result.ok) {
        setBody('')
        setDraftStatus(null)
        setFeedback(null)
        setSaveState('saved')
        clearAttachment()
        await router.invalidate()
      } else {
        // 010: 部分失敗 (テキストは届いたが画像が失敗)。テキストは二重送信を防ぐため
        // 入力欄をクリアし、添付は ready のまま残して「画像だけ再送」できるようにする (§7 低-5)。
        const textSent = result.parts?.some((p) => p.kind === 'text' && p.ok) ?? false
        const imageFailed = result.parts?.some((p) => p.kind === 'image' && !p.ok) ?? false
        if (textSent && imageFailed) {
          setBody('')
          setDraftStatus(null)
          setSaveState('saved')
          setError(m.thread_attach_partial_failure())
          // 送信済みテキストのバブルを反映 (添付ローカル状態は key 固定で保持される)
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

            {/* Auto-save pill */}
            {saveState === 'saving' && (
              <span style={{ fontSize: 11, color: 'var(--color-ink-3)', fontFamily: 'var(--font-mono)' }}>
                {m.reply_saving()}
              </span>
            )}
            {saveState === 'saved' && body !== (latestDraft?.body ?? '') && (
              <span style={{ fontSize: 11, color: 'var(--color-green-ink)', fontFamily: 'var(--font-mono)' }}>
                {m.reply_draft_saved()}
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

        {/* 010: 添付プレビュー (画像サムネイル + 取り消し) */}
        {attachment && (
          <div style={{ padding: '0 14px 8px' }}>
            <div
              style={{
                position: 'relative',
                display: 'inline-block',
                borderRadius: 8,
                overflow: 'hidden',
                border: '1px solid var(--color-line)',
              }}
            >
              <img
                src={attachment.previewUrl}
                alt=""
                style={{
                  display: 'block',
                  maxWidth: 160,
                  maxHeight: 120,
                  objectFit: 'cover',
                  opacity: uploadState === 'uploading' ? 0.5 : 1,
                }}
              />
              {uploadState === 'uploading' && (
                <span
                  className="animate-pulse"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    color: 'white',
                    background: 'oklch(0 0 0 / 0.35)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  …
                </span>
              )}
              <button
                type="button"
                onClick={clearAttachment}
                aria-label={m.thread_attach_remove()}
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  border: 'none',
                  color: 'white',
                  background: 'oklch(0 0 0 / 0.55)',
                  cursor: 'pointer',
                }}
              >
                <XIcon size={11} />
              </button>
            </div>
          </div>
        )}

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
            {/* 010: 画像添付ボタン (media 有効 & 窓が開いているとき) */}
            {showAttachButton && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void handlePickFile(file)
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending || uploadState === 'uploading' || attachment !== null}
                  aria-label={m.thread_attach_image()}
                  title={m.thread_attach_image()}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '6px 8px',
                    borderRadius: 7,
                    color: 'var(--color-ink-3)',
                    background: 'transparent',
                    border: '1px solid var(--color-line)',
                    cursor: sending || uploadState === 'uploading' || attachment !== null ? 'not-allowed' : 'pointer',
                    opacity: sending || uploadState === 'uploading' || attachment !== null ? 0.5 : 1,
                    transition: 'all 120ms',
                  }}
                >
                  <ImageIcon size={14} />
                </button>
              </>
            )}
            {!isWindowClosed && (
              <span style={{ fontSize: 11, color: 'var(--color-ink-4)', fontFamily: 'var(--font-mono)' }}>
                ⌘↵
              </span>
            )}
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={sendDisabled}
              aria-disabled={sendDisabled}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 14px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                color: 'white',
                background: sendDisabled ? 'var(--color-ink-4)' : 'var(--color-primary)',
                cursor: sendDisabled ? 'not-allowed' : 'pointer',
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
