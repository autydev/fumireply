import type { ConversationSummary } from './list-conversations.fn'
import { m } from '~/paraglide/messages'

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS

export function slaState(conv: ConversationSummary): 'overdue' | 'warn' | 'policy-warn' | null {
  if (!conv.last_inbound_at) return null
  const elapsedMs = Date.now() - new Date(conv.last_inbound_at).getTime()
  if (elapsedMs >= DAY_MS) return 'policy-warn'
  if (conv.unread_count > 0) {
    const hrs = elapsedMs / HOUR_MS
    if (hrs >= 4) return 'overdue'
    if (hrs >= 2) return 'warn'
  }
  return null
}

export function formatTime(isoStr: string): string {
  const d = new Date(isoStr)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60_000) return m.time_just_now()
  if (diff < HOUR_MS) return m.time_minutes_ago({ minutes: Math.floor(diff / 60_000) })
  if (diff < DAY_MS) return m.time_hours_ago({ hours: Math.floor(diff / HOUR_MS) })
  return m.time_days_ago({ days: Math.floor(diff / DAY_MS) })
}
