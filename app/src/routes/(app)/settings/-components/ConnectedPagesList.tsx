import type { ConnectedPageSetting } from '../-lib/list-settings.fn'
import { PageCustomPromptEditor } from './PageCustomPromptEditor'
import { EmptyState } from './EmptyState'

interface ConnectedPagesListProps {
  connectedPages: ConnectedPageSetting[]
}

export function ConnectedPagesList({ connectedPages }: ConnectedPagesListProps) {
  if (connectedPages.length === 0) {
    return <EmptyState />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {connectedPages.map((page) => (
        <PageCustomPromptEditor
          key={page.id}
          connectedPageId={page.id}
          pageName={page.pageName}
          customPrompt={page.customPrompt}
        />
      ))}
    </div>
  )
}
