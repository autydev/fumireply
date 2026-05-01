import { createFileRoute } from '@tanstack/react-router'
import { listConversationsFn } from './-lib/list-conversations.fn'
import { InboxList } from './-components/InboxList'

export const Route = createFileRoute('/(app)/inbox/')({
  loader: async () => {
    return await listConversationsFn()
  },
  component: InboxPage,
})

function InboxPage() {
  const { conversations } = Route.useLoaderData()
  return (
    <main>
      <h1>受信トレイ</h1>
      <InboxList conversations={conversations} />
    </main>
  )
}
