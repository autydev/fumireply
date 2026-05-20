-- 0002_customer_context.sql
-- Adds 6 new columns to connected_pages and conversations for customer context and settings
-- (003-customer-context-and-settings feature)

-- connected_pages: page-level custom prompt (shop policy)
ALTER TABLE "connected_pages"
  ADD COLUMN "custom_prompt" text;

ALTER TABLE "connected_pages"
  ADD CONSTRAINT "connected_pages_custom_prompt_length"
  CHECK ("custom_prompt" IS NULL OR char_length("custom_prompt") <= 2000);

-- conversations: summary + cursor + tone + custom instruction + internal note
ALTER TABLE "conversations"
  ADD COLUMN "summary" text,
  ADD COLUMN "last_summarized_at" timestamptz,
  ADD COLUMN "tone_preset" varchar(20),
  ADD COLUMN "custom_prompt" text,
  ADD COLUMN "note" text;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_tone_preset_values"
  CHECK ("tone_preset" IS NULL OR "tone_preset" IN ('friendly', 'professional', 'concise'));

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_custom_prompt_length"
  CHECK ("custom_prompt" IS NULL OR char_length("custom_prompt") <= 1000);

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_note_length"
  CHECK ("note" IS NULL OR char_length("note") <= 1000);
