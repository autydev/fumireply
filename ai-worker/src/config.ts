// Mirror of app/src/lib/settings/char-limits.ts — ai-worker is a separate Lambda package
// and cannot import from app/. Keep these constants in sync manually.
export const SUMMARY_TRIGGER_THRESHOLD_CHARS = parseInt(
  process.env.SUMMARY_TRIGGER_THRESHOLD_CHARS ?? '2000',
  10,
)
export const RECENT_MESSAGES_CAP = 50
export const SUMMARY_MAX_INPUT_MESSAGES = 200
