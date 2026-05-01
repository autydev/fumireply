import type { MessageWithDraft } from '../-lib/get-conversation.fn'

export function ThreadMessages({ messages }: { messages: MessageWithDraft[] }) {
  if (messages.length === 0) {
    return <p>メッセージはありません</p>
  }

  return (
    <ul className="thread-messages">
      {messages.map((msg) => (
        <li
          key={msg.id}
          className={`message message--${msg.direction}`}
          data-direction={msg.direction}
        >
          <p className="message-body">{msg.body}</p>
          {msg.direction === 'outbound' && msg.send_status && (
            <span className="message-status" data-status={msg.send_status}>
              {msg.send_status === 'sent' && '✓'}
              {msg.send_status === 'failed' && '✗'}
              {msg.send_status === 'pending' && '…'}
            </span>
          )}
          {msg.direction === 'inbound' &&
            msg.ai_draft?.status === 'ready' &&
            msg.ai_draft.body && (
              <p className="ai-draft-hint">AI suggested: {msg.ai_draft.body}</p>
            )}
          <time className="message-timestamp" dateTime={msg.timestamp}>
            {new Date(msg.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
          </time>
        </li>
      ))}
    </ul>
  )
}
