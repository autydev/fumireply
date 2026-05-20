import { Avatar } from '~/components/ui/avatar'

interface CustomerPanelHeaderProps {
  conversationId: string
  customerName: string | null
  customerPsid: string
}

export function CustomerPanelHeader({ conversationId, customerName, customerPsid }: CustomerPanelHeaderProps) {
  const displayName = customerName ?? customerPsid

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 16px 12px',
        borderBottom: '1px solid var(--color-line)',
      }}
    >
      <Avatar name={displayName} size={40} seed={conversationId.charCodeAt(0)} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayName}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--color-ink-3)',
            fontFamily: 'var(--font-mono)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {customerPsid}
        </div>
      </div>
    </div>
  )
}
