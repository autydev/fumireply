import type { ConversationSummary } from '../-lib/list-conversations.fn'

export function InboxList({ conversations }: { conversations: ConversationSummary[] }) {
  if (conversations.length === 0) {
    return <p>メッセージはありません</p>
  }

  return (
    <ul>
      {conversations.map((conv) => (
        <li key={conv.id}>
          <a href={`/threads/${conv.id}`}>
            <span className="customer-name">{conv.customer_name ?? conv.customer_psid}</span>
            {conv.unread_count > 0 && (
              <span className="unread-badge" aria-label={`${conv.unread_count} 件の未読`}>
                {conv.unread_count}
              </span>
            )}
            <span className="message-preview">{conv.last_message_preview}</span>
            <span className="window-status">
              {conv.within_24h_window ? '24h窓内' : '24h窓外'}
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}
