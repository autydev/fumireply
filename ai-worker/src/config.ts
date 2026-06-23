// Mirror of app/src/lib/settings/char-limits.ts — ai-worker is a separate Lambda package
// and cannot import from app/. Keep these constants in sync manually.
const _threshold = parseInt(process.env.SUMMARY_TRIGGER_THRESHOLD_CHARS ?? '2000', 10)
export const SUMMARY_TRIGGER_THRESHOLD_CHARS = Number.isFinite(_threshold) ? _threshold : 2000
export const RECENT_MESSAGES_CAP = 50
export const SUMMARY_MAX_INPUT_MESSAGES = 200
// Max unanswered inbound messages (since the last operator reply) addressed in one draft.
export const UNANSWERED_CAP = 30
// 005: SQS DelaySeconds used by ai-worker when self-enqueueing a follow-up
// auto-batch after a successful regenerate finds newer inbounds. Mirrors
// webhook DRAFT_DEBOUNCE_SECONDS (defaults to 20).
const _debounce = parseInt(process.env.DRAFT_DEBOUNCE_SECONDS ?? '20', 10)
export const DRAFT_DEBOUNCE_SECONDS = Number.isFinite(_debounce) ? _debounce : 20
