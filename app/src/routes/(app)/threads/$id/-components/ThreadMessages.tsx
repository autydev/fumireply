import { useEffect, useRef } from 'react'
import type { MessageWithDraft } from '../-lib/get-conversation.fn'
import { CheckIcon, ClockIcon } from '~/components/ui/icons'

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
        メッセージはありません
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

  if (isInbound) {
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
            }}
          >
            {msg.body}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--color-ink-4)',
              marginTop: 4,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {timeStr}
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
        }}
      >
        {msg.body}
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
            送信中…
          </span>
        )}
        {isSent && (
          <span style={{ display: 'inline-flex', color: 'var(--color-primary)', gap: '-2px' }}>
            <CheckIcon size={11} stroke={2.5} />
            <CheckIcon size={11} stroke={2.5} style={{ marginLeft: -6 }} />
          </span>
        )}
        {isFailed && (
          <span style={{ color: 'var(--color-rose-ink)', fontSize: 11 }}>送信失敗</span>
        )}
      </div>
    </div>
  )
}
