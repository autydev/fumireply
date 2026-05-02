import { createFileRoute, Link } from '@tanstack/react-router'
import type { MessageWithDraft } from './-lib/get-conversation.fn'
import { getConversationFn } from './-lib/get-conversation.fn'
import { ThreadMessages } from './-components/ThreadMessages'
import { ReplyForm } from './-components/ReplyForm'
import { Avatar } from '~/components/ui/avatar'
import { InboxList } from '../../inbox/-components/InboxList'
import { listConversationsFn } from '../../inbox/-lib/list-conversations.fn'
import { ChevronLeftIcon, MoreHorizIcon, StarIcon } from '~/components/ui/icons'

export const Route = createFileRoute('/(app)/threads/$id/')({
  loader: async ({ params }) => {
    const [convData, listData] = await Promise.all([
      getConversationFn({ data: { id: params.id } }),
      listConversationsFn(),
    ])
    return { ...convData, conversations: listData.conversations }
  },
  component: ThreadPage,
})

function ThreadPage() {
  const { conversation, messages, latest_draft, conversations } = Route.useLoaderData()
  const { id } = Route.useParams()

  const latestInboundMessageId =
    messages
      .slice()
      .reverse()
      .find((m: MessageWithDraft) => m.direction === 'inbound')?.id ?? null

  const displayName = conversation.customer_name ?? conversation.customer_psid

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%' }}>
      {/* Inbox list column */}
      <InboxList conversations={conversations} selectedId={id} />

      {/* Thread view */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-bg)',
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        {/* Thread header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 20px',
            background: 'var(--color-bg-raised)',
            borderBottom: '1px solid var(--color-line)',
            flexShrink: 0,
          }}
        >
          <Link
            to="/inbox"
            style={{
              display: 'flex',
              alignItems: 'center',
              color: 'var(--color-ink-3)',
              padding: 4,
              borderRadius: 6,
              textDecoration: 'none',
              transition: 'color 120ms',
            }}
          >
            <ChevronLeftIcon size={16} />
          </Link>

          <Avatar name={displayName} size={36} seed={id.charCodeAt(0)} />

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-ink)' }}>
              {displayName}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--color-ink-3)', fontFamily: 'var(--font-mono)' }}>
              {conversation.customer_psid}
              {conversation.within_24h_window ? (
                <span
                  style={{
                    marginLeft: 8,
                    color: 'var(--color-green-ink)',
                    background: 'var(--color-green-soft)',
                    border: '1px solid oklch(0.68 0.13 155 / 0.2)',
                    borderRadius: 4,
                    padding: '0 5px',
                    fontSize: 10,
                    fontWeight: 600,
                  }}
                >
                  24h窓内
                </span>
              ) : (
                <span
                  style={{
                    marginLeft: 8,
                    color: 'var(--color-rose-ink)',
                    background: 'var(--color-rose-soft)',
                    border: '1px solid oklch(0.65 0.18 20 / 0.2)',
                    borderRadius: 4,
                    padding: '0 5px',
                    fontSize: 10,
                    fontWeight: 600,
                  }}
                >
                  24h窓外
                </span>
              )}
            </div>
          </div>

          <button
            style={{
              padding: 6,
              borderRadius: 7,
              color: 'var(--color-ink-3)',
              cursor: 'pointer',
              transition: 'background 120ms',
            }}
            title="スター"
          >
            <StarIcon size={16} />
          </button>
          <button
            style={{
              padding: 6,
              borderRadius: 7,
              color: 'var(--color-ink-3)',
              cursor: 'pointer',
              transition: 'background 120ms',
            }}
            title="その他"
          >
            <MoreHorizIcon size={16} />
          </button>
        </div>

        {/* Messages area */}
        <ThreadMessages messages={messages} />

        {/* Reply form */}
        <ReplyForm
          key={conversation.id}
          conversationId={conversation.id}
          conversation={conversation}
          latestDraft={latest_draft}
          latestInboundMessageId={latestInboundMessageId}
        />
      </div>
    </div>
  )
}
