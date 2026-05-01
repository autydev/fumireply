import { createFileRoute } from '@tanstack/react-router'
import { getConversationFn } from './-lib/get-conversation.fn'
import { ThreadMessages } from './-components/ThreadMessages'
import { ReplyForm } from './-components/ReplyForm'

export const Route = createFileRoute('/(app)/threads/$id/')({
  loader: async ({ params }) => {
    return await getConversationFn({ data: { id: params.id } })
  },
  component: ThreadPage,
})

function ThreadPage() {
  const { conversation, messages, latest_draft } = Route.useLoaderData()

  const latestInboundMessageId =
    messages
      .slice()
      .reverse()
      .find((m: (typeof messages)[number]) => m.direction === 'inbound')?.id ?? null

  return (
    <main>
      <h1>{conversation.customer_name ?? conversation.customer_psid}</h1>
      <ThreadMessages messages={messages} />
      <ReplyForm
        key={conversation.id}
        conversationId={conversation.id}
        conversation={conversation}
        latestDraft={latest_draft}
        latestInboundMessageId={latestInboundMessageId}
      />
    </main>
  )
}
