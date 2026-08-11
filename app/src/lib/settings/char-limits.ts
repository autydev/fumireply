import { z } from 'zod'

export const PAGE_PROMPT_MAX = 2000
export const CUSTOMER_PROMPT_MAX = 1000
export const NOTE_MAX = 1000
export const PRICE_GUIDE_MAX = 4000
const _threshold = parseInt(process.env.SUMMARY_TRIGGER_THRESHOLD_CHARS ?? '2000', 10)
export const SUMMARY_TRIGGER_THRESHOLD_CHARS = Number.isFinite(_threshold) ? _threshold : 2000

export const pagePromptSchema = z
  .string()
  .max(PAGE_PROMPT_MAX, 'PAGE_PROMPT_TOO_LONG')
  .nullable()
  .optional()

export const customerPromptSchema = z
  .string()
  .max(CUSTOMER_PROMPT_MAX, 'CUSTOMER_PROMPT_TOO_LONG')
  .nullable()
  .optional()

export const noteSchema = z
  .string()
  .max(NOTE_MAX, 'NOTE_TOO_LONG')
  .nullable()
  .optional()

export const priceGuideSchema = z
  .string()
  .max(PRICE_GUIDE_MAX, 'PRICE_GUIDE_TOO_LONG')
  .nullable()
  .optional()
