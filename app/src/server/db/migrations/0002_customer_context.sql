ALTER TABLE "connected_pages" ADD COLUMN "custom_prompt" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_summarized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "tone_preset" varchar(20);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "custom_prompt" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "connected_pages" ADD CONSTRAINT "connected_pages_custom_prompt_length" CHECK ("connected_pages"."custom_prompt" IS NULL OR char_length("connected_pages"."custom_prompt") <= 2000);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tone_preset_values" CHECK ("conversations"."tone_preset" IS NULL OR "conversations"."tone_preset" IN ('friendly', 'professional', 'concise'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_custom_prompt_length" CHECK ("conversations"."custom_prompt" IS NULL OR char_length("conversations"."custom_prompt") <= 1000);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_note_length" CHECK ("conversations"."note" IS NULL OR char_length("conversations"."note") <= 1000);