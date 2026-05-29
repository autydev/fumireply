import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { listConversationsFn } from './-lib/list-conversations.fn'
import { InboxList } from './-components/InboxList'
import { InboxIcon } from '~/components/ui/icons'
import { m } from '~/paraglide/messages'

type FilterKey = 'all' | 'unread' | 'draft' | 'overdue'

export const Route = createFileRoute('/(app)/inbox/')({
  loader: async () => {
    return await listConversationsFn()
  },
  component: InboxPage,
})

function InboxPage() {
  const { conversations } = Route.useLoaderData()
  const [filter, setFilter] = useState<FilterKey>('all')

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%' }}>
      <InboxList
        conversations={conversations}
        filter={filter}
        onFilterChange={setFilter}
      />
      {/* Thread area placeholder: selecting a conversation navigates to /threads/$id */}
      <div
        className="inbox-empty-pane"
        style={{
          background: 'var(--color-bg)',
          gap: 10,
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            background: 'var(--color-bg-raised)',
            border: '1px solid var(--color-line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-ink-4)',
            marginBottom: 4,
          }}
        >
          <InboxIcon size={24} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-ink-2)' }}>
          {m.inbox_empty_state()}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--color-ink-4)', textAlign: 'center', maxWidth: 260, lineHeight: 1.6 }}>
          {m.inbox_select_subtitle()}
        </div>
      </div>
    </div>
  )
}
