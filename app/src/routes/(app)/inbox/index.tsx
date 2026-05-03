import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { listConversationsFn } from './-lib/list-conversations.fn'
import { InboxList } from './-components/InboxList'

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
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-bg)',
          color: 'var(--color-ink-3)',
          fontSize: 13,
          gap: 8,
        }}
      >
        <div style={{ fontSize: 32, opacity: 0.3 }}>💬</div>
        <div>会話を選択してください</div>
      </div>
    </div>
  )
}
