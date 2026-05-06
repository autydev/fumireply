import { Link } from '@tanstack/react-router'
import type { ConversationSummary } from '../-lib/list-conversations.fn'
import { slaState, formatTime } from '../-lib/sla-helpers'
import { Avatar } from '~/components/ui/avatar'
import { SearchIcon, ClockIcon } from '~/components/ui/icons'
import { m } from '~/paraglide/messages'

type FilterKey = 'all' | 'unread' | 'draft' | 'overdue'

type Props = {
  conversations: ConversationSummary[]
  selectedId?: string
  filter?: FilterKey
  onFilterChange?: (f: FilterKey) => void
}

export function InboxList({ conversations, selectedId, filter = 'all', onFilterChange }: Props) {
  const filters: { key: FilterKey; label: string; count: number }[] = [
    { key: 'all', label: m.inbox_filter_all(), count: conversations.length },
    { key: 'unread', label: m.inbox_filter_unread(), count: conversations.filter((c) => c.unread_count > 0).length },
    {
      key: 'overdue',
      label: m.inbox_filter_overdue(),
      count: conversations.filter((c) => {
        const s = slaState(c)
        return s === 'overdue' || s === 'warn'
      }).length,
    },
  ]

  const filtered = conversations.filter((c) => {
    if (filter === 'unread') return c.unread_count > 0
    if (filter === 'overdue') {
      const s = slaState(c)
      return s === 'overdue' || s === 'warn'
    }
    return true
  })

  return (
    <div
      style={{
        width: 340,
        flexShrink: 0,
        background: 'var(--color-bg-raised)',
        borderRight: '1px solid var(--color-line)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* Header */}
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--color-line)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>受信トレイ</span>
          <span style={{ fontSize: 11.5, color: 'var(--color-ink-3)', fontFamily: 'var(--font-mono)' }}>
            {conversations.length} 会話
          </span>
        </div>
        {/* Search box (visual only) */}
        <button
          aria-label="会話を検索"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            background: 'var(--color-bg-sunken)',
            border: '1px solid var(--color-line)',
            borderRadius: 8,
            cursor: 'text',
            width: '100%',
            textAlign: 'left',
          }}
        >
          <SearchIcon size={13} />
          <span style={{ fontSize: 12.5, color: 'var(--color-ink-4)' }}>顧客・メッセージを検索…</span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10.5,
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-ink-4)',
              background: 'var(--color-bg-hover)',
              border: '1px solid var(--color-line)',
              borderRadius: 4,
              padding: '1px 5px',
            }}
          >
            ⌘K
          </span>
        </button>
      </div>

      {/* Filter chips */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '8px 14px',
          borderBottom: '1px solid var(--color-line)',
          flexWrap: 'wrap',
        }}
      >
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => onFilterChange?.(f.key)}
            aria-pressed={filter === f.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 10px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: filter === f.key ? 600 : 500,
              background: filter === f.key ? 'var(--color-bg-active)' : 'transparent',
              color: filter === f.key ? 'var(--color-ink)' : 'var(--color-ink-3)',
              cursor: 'pointer',
              transition: 'background 120ms',
            }}
          >
            {f.label}
            <span
              style={{
                fontSize: 10.5,
                fontFamily: 'var(--font-mono)',
                color: filter === f.key ? 'var(--color-ink-2)' : 'var(--color-ink-4)',
              }}
            >
              {f.count}
            </span>
          </button>
        ))}
      </div>

      {/* Conversation list */}
      <ul role="list" style={{ flex: 1, overflowY: 'auto', listStyle: 'none', margin: 0, padding: 0 }}>
        {filtered.length === 0 ? (
          <li
            style={{
              padding: '40px 20px',
              textAlign: 'center',
              color: 'var(--color-ink-3)',
              fontSize: 13,
            }}
          >
            {m.inbox_empty_state()}
          </li>
        ) : (
          filtered.map((conv, i) => {
            const sla = slaState(conv)
            const isSelected = selectedId === conv.id
            const isUnread = conv.unread_count > 0

            return (
              <li key={conv.id} style={{ listStyle: 'none' }}>
              <Link
                to={`/threads/${conv.id}` as string}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '11px 14px',
                  borderBottom: '1px solid var(--color-line)',
                  background: isSelected
                    ? 'var(--color-bg-active)'
                    : isUnread
                      ? 'var(--color-primary-soft)'
                      : 'transparent',
                  textDecoration: 'none',
                  color: 'inherit',
                  position: 'relative',
                  cursor: 'pointer',
                  transition: 'background 120ms',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'var(--color-bg-hover)'
                }}
                onMouseLeave={(e) => {
                  if (!isSelected)
                    e.currentTarget.style.background = isUnread
                      ? 'var(--color-primary-soft)'
                      : 'transparent'
                }}
              >
                {/* Unread dot */}
                {isUnread && (
                  <div
                    style={{
                      position: 'absolute',
                      left: 4,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: 'var(--color-primary)',
                      flexShrink: 0,
                    }}
                  />
                )}

                <Avatar name={conv.customer_name ?? conv.customer_psid} size={36} seed={i} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Line 1: name + time */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: isUnread ? 700 : 500,
                        color: 'var(--color-ink)',
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {conv.customer_name ?? conv.customer_psid}
                    </span>
                    <span
                      suppressHydrationWarning
                      style={{
                        fontSize: 11,
                        color: 'var(--color-ink-3)',
                        fontFamily: 'var(--font-mono)',
                        flexShrink: 0,
                      }}
                    >
                      {formatTime(conv.last_message_at)}
                    </span>
                  </div>

                  {/* Preview */}
                  <div
                    style={{
                      fontSize: 12.5,
                      color: isUnread ? 'var(--color-ink-2)' : 'var(--color-ink-3)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginBottom: 4,
                    }}
                  >
                    {conv.last_message_direction === 'outbound' && (
                      <span style={{ color: 'var(--color-ink-4)' }}>あなた: </span>
                    )}
                    {conv.last_message_preview || '(メッセージなし)'}
                  </div>

                  {/* Meta: 24h window + SLA */}
                  <div suppressHydrationWarning style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    {!conv.within_24h_window && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          fontSize: 10.5,
                          fontWeight: 600,
                          color: 'var(--color-rose-ink)',
                          background: 'var(--color-rose-soft)',
                          border: '1px solid oklch(0.65 0.18 20 / 0.2)',
                          borderRadius: 4,
                          padding: '1px 6px',
                        }}
                      >
                        {m.thread_window_outside_24h()}
                      </span>
                    )}
                    {sla === 'overdue' && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          fontSize: 10.5,
                          fontWeight: 600,
                          color: 'var(--color-rose-ink)',
                          background: 'var(--color-rose-soft)',
                          border: '1px solid oklch(0.65 0.18 20 / 0.2)',
                          borderRadius: 4,
                          padding: '1px 6px',
                        }}
                      >
                        <ClockIcon size={9} />
                        4h+
                      </span>
                    )}
                    {sla === 'warn' && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          fontSize: 10.5,
                          fontWeight: 600,
                          color: 'var(--color-amber-ink)',
                          background: 'var(--color-amber-soft)',
                          border: '1px solid oklch(0.78 0.13 75 / 0.2)',
                          borderRadius: 4,
                          padding: '1px 6px',
                        }}
                      >
                        <ClockIcon size={9} />
                        2h+
                      </span>
                    )}
                    {sla === 'policy-warn' && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          fontSize: 10.5,
                          fontWeight: 600,
                          color: 'var(--color-amber-ink)',
                          background: 'var(--color-amber-soft)',
                          border: '1px solid oklch(0.78 0.13 75 / 0.2)',
                          borderRadius: 4,
                          padding: '1px 6px',
                        }}
                      >
                        24h迫る
                      </span>
                    )}
                    {isUnread && conv.unread_count > 0 && (
                      <span
                        style={{
                          marginLeft: 'auto',
                          background: 'var(--color-rose)',
                          color: 'white',
                          fontSize: 10.5,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 999,
                          minWidth: 18,
                          textAlign: 'center',
                        }}
                      >
                        {conv.unread_count}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
              </li>
            )
          })
        )}
      </ul>
    </div>
  )
}
