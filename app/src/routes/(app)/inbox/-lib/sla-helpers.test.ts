import { describe, expect, it, vi, afterEach } from 'vitest'
import type { ConversationSummary } from './list-conversations.fn'
import { HOUR_MS, DAY_MS, slaState, formatTime } from './sla-helpers'

const BASE_PSID = 'psid-1'
const BASE_CONV: ConversationSummary = {
  id: 'c1',
  customer_psid: BASE_PSID,
  customer_name: null,
  last_message_at: '2026-01-01T00:00:00.000Z',
  last_inbound_at: '2026-01-01T00:00:00.000Z',
  unread_count: 1,
  last_message_preview: 'hi',
  last_message_direction: 'inbound',
  within_24h_window: true,
}

// Pin Date.now() so tests are deterministic
const NOW = new Date('2026-01-01T12:00:00.000Z').getTime()

afterEach(() => {
  vi.restoreAllMocks()
})

describe('slaState', () => {
  it('returns null when last_inbound_at is null', () => {
    const conv = { ...BASE_CONV, last_inbound_at: null }
    expect(slaState(conv)).toBe(null)
  })

  it('returns null when unread_count is 0 and under 24h', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const inboundAt = new Date(NOW - 3 * HOUR_MS).toISOString()
    const conv = { ...BASE_CONV, last_inbound_at: inboundAt, unread_count: 0 }
    expect(slaState(conv)).toBe(null)
  })

  it('returns "warn" when unread and elapsed >= 2h but < 4h', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const inboundAt = new Date(NOW - 2.5 * HOUR_MS).toISOString()
    const conv = { ...BASE_CONV, last_inbound_at: inboundAt, unread_count: 1 }
    expect(slaState(conv)).toBe('warn')
  })

  it('returns "overdue" when unread and elapsed >= 4h but < 24h', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const inboundAt = new Date(NOW - 5 * HOUR_MS).toISOString()
    const conv = { ...BASE_CONV, last_inbound_at: inboundAt, unread_count: 1 }
    expect(slaState(conv)).toBe('overdue')
  })

  it('returns "policy-warn" when elapsed >= 24h regardless of unread_count', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const inboundAt = new Date(NOW - DAY_MS).toISOString()
    const conv = { ...BASE_CONV, last_inbound_at: inboundAt, unread_count: 0 }
    expect(slaState(conv)).toBe('policy-warn')
  })

  it('returns "policy-warn" when elapsed > 24h with unread_count > 0', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const inboundAt = new Date(NOW - 25 * HOUR_MS).toISOString()
    const conv = { ...BASE_CONV, last_inbound_at: inboundAt, unread_count: 3 }
    expect(slaState(conv)).toBe('policy-warn')
  })
})

describe('formatTime', () => {
  it('returns "たった今" when diff < 60s', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const isoStr = new Date(NOW - 30_000).toISOString()
    expect(formatTime(isoStr)).toBe('たった今')
  })

  it('returns minutes-ago for diff 1m–59m', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const isoStr = new Date(NOW - 45 * 60_000).toISOString()
    expect(formatTime(isoStr)).toBe('45分前')
  })

  it('returns hours-ago for diff 1h–23h', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const isoStr = new Date(NOW - 3 * HOUR_MS).toISOString()
    expect(formatTime(isoStr)).toBe('3時間前')
  })

  it('returns days-ago for diff >= 24h', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const isoStr = new Date(NOW - 2 * DAY_MS).toISOString()
    expect(formatTime(isoStr)).toBe('2日前')
  })
})
