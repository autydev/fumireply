import { useEffect, useRef, useState } from 'react'
import type { MessageAttachmentView, MessageWithDraft } from '../-lib/get-conversation.fn'
import { CheckIcon, ClockIcon } from '~/components/ui/icons'
import { m } from '~/paraglide/messages'
import { buildTranslateUrl } from '~/lib/translate-url'

// 009: 添付の表示解決。attachments が空で message_type が非 text のレガシー行
// (本機能以前の受信 / body クリーンアップ済み) は message_type から 1 件ぶんの
// 表示を導出する。旧形式 (body に URL) の判定は持たない (FR-004a)。
function resolveAttachmentViews(msg: MessageWithDraft): MessageAttachmentView[] {
  if (msg.attachments.length > 0) return msg.attachments
  if (msg.message_type === 'text') return []
  return [{ index: 0, type: msg.message_type, url: null }]
}

function attachmentLabel(type: MessageAttachmentView['type']): string {
  switch (type) {
    case 'video':
      return m.thread_attachment_video()
    case 'audio':
      return m.thread_attachment_audio()
    case 'file':
      return m.thread_attachment_file()
    case 'sticker':
      return m.thread_attachment_sticker()
    case 'image':
      return m.thread_attachment_image_unavailable()
    default:
      return m.thread_attachment_unknown()
  }
}

const ATTACHMENT_ICONS: Record<MessageAttachmentView['type'], string> = {
  image: '🖼',
  video: '🎬',
  audio: '🎵',
  file: '📎',
  sticker: '💟',
  unknown: '📦',
}

// 保存済み画像: <img> 表示 + クリックで原寸モーダル (Esc / 背景クリック / ✕ で閉じる)
function ImageAttachment({ url }: { url: string }) {
  const [open, setOpen] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    // aria-modal な dialog はフォーカス管理が前提: 開いたら閉じるボタンへ初期フォーカス、
    // 閉じたら元のトリガーへ復帰させる
    closeButtonRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      triggerRef.current?.focus()
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={m.thread_attachment_image_alt()}
        style={{
          padding: 0,
          border: 'none',
          background: 'none',
          cursor: 'zoom-in',
          display: 'block',
        }}
      >
        <img
          src={url}
          alt={m.thread_attachment_image_alt()}
          loading="lazy"
          style={{
            maxWidth: 240,
            maxHeight: 240,
            borderRadius: 10,
            display: 'block',
            objectFit: 'cover',
          }}
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={m.thread_attachment_image_alt()}
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            cursor: 'zoom-out',
          }}
        >
          <img
            src={url}
            alt={m.thread_attachment_image_alt()}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '92vw', maxHeight: '92vh', objectFit: 'contain', cursor: 'default' }}
          />
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setOpen(false)}
            aria-label={m.thread_attachment_modal_close()}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              width: 36,
              height: 36,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(255, 255, 255, 0.15)',
              color: 'white',
              fontSize: 18,
              lineHeight: 1,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      )}
    </>
  )
}

// 取得不可プレースホルダ / 種別ラベル (video・audio・file・sticker・unknown)。
// 空バブルを出さないための受け皿 (SC-003)。インライン再生・DL 提供はスコープ外。
function AttachmentChip({
  type,
  onDark,
}: {
  type: MessageAttachmentView['type']
  onDark: boolean
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderRadius: 8,
        border: `1px dashed ${onDark ? 'rgba(255,255,255,0.45)' : 'var(--color-line)'}`,
        color: onDark ? 'rgba(255,255,255,0.9)' : 'var(--color-ink-3)',
        fontSize: 12,
      }}
    >
      <span aria-hidden="true">{ATTACHMENT_ICONS[type]}</span>
      {attachmentLabel(type)}
    </span>
  )
}

function AttachmentList({
  attachments,
  onDark,
}: {
  attachments: MessageAttachmentView[]
  onDark: boolean
}) {
  if (attachments.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {attachments.map((att) =>
        att.type === 'image' && att.url ? (
          <ImageAttachment key={att.index} url={att.url} />
        ) : (
          <div key={att.index}>
            <AttachmentChip type={att.type} onDark={onDark} />
          </div>
        ),
      )}
    </div>
  )
}

export function ThreadMessages({ messages }: { messages: MessageWithDraft[] }) {
  const bottomRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' })
  }, [messages.length])

  if (messages.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-ink-3)',
          fontSize: 13,
        }}
      >
        {m.thread_no_messages()}
      </div>
    )
  }

  return (
    <ul
      role="list"
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        listStyle: 'none',
        margin: 0,
      }}
    >
      {messages.map((msg) => (
        <li key={msg.id} style={{ listStyle: 'none' }}>
          <MessageBubble msg={msg} />
        </li>
      ))}
      <li ref={bottomRef} aria-hidden="true" style={{ listStyle: 'none', height: 0 }} />
    </ul>
  )
}

function MessageBubble({ msg }: { msg: MessageWithDraft }) {
  const isInbound = msg.direction === 'inbound'
  const timeStr = new Date(msg.timestamp).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    month: 'numeric',
    day: 'numeric',
  })

  const attachmentViews = resolveAttachmentViews(msg)

  if (isInbound) {
    const canTranslate = msg.body.trim().length > 0
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', maxWidth: '75%' }}>
        <div>
          <div
            style={{
              background: 'var(--color-bg-raised)',
              border: '1px solid var(--color-line)',
              borderRadius: '14px 14px 14px 4px',
              padding: '10px 14px',
              fontSize: 14,
              lineHeight: 1.5,
              color: 'var(--color-ink)',
              boxShadow: 'var(--shadow-xs)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {msg.body.length > 0 && <span>{msg.body}</span>}
            <AttachmentList attachments={attachmentViews} onDark={false} />
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--color-ink-4)',
              marginTop: 4,
              fontFamily: 'var(--font-mono)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>{timeStr}</span>
            {canTranslate && (
              <a
                href={buildTranslateUrl(msg.body, 'ja')}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={m.thread_translate_aria()}
                style={{
                  color: 'var(--color-ink-3)',
                  textDecoration: 'underline',
                  textDecorationStyle: 'dotted',
                  textUnderlineOffset: 2,
                  fontFamily: 'inherit',
                }}
              >
                {m.thread_translate_button()}
              </a>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Outbound
  const isSent = msg.send_status === 'sent'
  const isFailed = msg.send_status === 'failed'
  const isPending = msg.send_status === 'pending'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '75%', marginLeft: 'auto' }}>
      <div
        style={{
          background: isFailed ? 'var(--color-rose-soft)' : 'var(--color-primary)',
          color: isFailed ? 'var(--color-rose-ink)' : 'white',
          border: isFailed ? '1px solid oklch(0.65 0.18 20 / 0.3)' : 'none',
          borderRadius: '14px 14px 4px 14px',
          padding: '10px 14px',
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {msg.body.length > 0 && <span>{msg.body}</span>}
        <AttachmentList attachments={attachmentViews} onDark={!isFailed} />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginTop: 4,
          fontSize: 11,
          color: 'var(--color-ink-4)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {timeStr}
        {isPending && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              color: 'var(--color-ink-3)',
              fontSize: 11,
            }}
          >
            <ClockIcon size={11} />
            {m.reply_sending_button()}
          </span>
        )}
        {isSent && (
          <span aria-label={m.thread_message_sent()} style={{ display: 'inline-flex', color: 'var(--color-primary)', gap: '-2px' }}>
            <CheckIcon size={11} stroke={2.5} />
            <CheckIcon size={11} stroke={2.5} style={{ marginLeft: -6 }} />
          </span>
        )}
        {isFailed && (
          <span style={{ color: 'var(--color-rose-ink)', fontSize: 11 }}>{m.thread_message_failed()}</span>
        )}
      </div>
    </div>
  )
}
