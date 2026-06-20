-- ai_drafts: per-message → conversation-scoped (at most one active draft per conversation).
-- Order matters: backfill conversation_id before NOT NULL, and dedup active rows
-- before creating the partial unique index.

-- 1. Drop the old per-message unique + FK; allow message_id to be a nullable anchor.
ALTER TABLE "ai_drafts" DROP CONSTRAINT IF EXISTS "ai_drafts_message_id_unique";--> statement-breakpoint
ALTER TABLE "ai_drafts" DROP CONSTRAINT IF EXISTS "ai_drafts_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "ai_drafts" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint

-- 2. Add conversation_id (nullable first so existing rows survive).
ALTER TABLE "ai_drafts" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint

-- 3. Backfill conversation_id from the anchor message.
UPDATE "ai_drafts" d
SET "conversation_id" = m."conversation_id"
FROM "messages" m
WHERE d."message_id" = m."id" AND d."conversation_id" IS NULL;--> statement-breakpoint

-- 4. Drop orphan drafts whose anchor message is gone (cannot resolve a conversation).
DELETE FROM "ai_drafts" WHERE "conversation_id" IS NULL;--> statement-breakpoint

-- 5. Enforce NOT NULL + FK now that every row has a conversation_id.
ALTER TABLE "ai_drafts" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- 6. Keep only the newest active (pending/ready) draft per conversation; demote the rest.
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "conversation_id"
           ORDER BY "created_at" DESC, "id" DESC
         ) AS rn
  FROM "ai_drafts"
  WHERE "status" IN ('pending', 'ready')
)
UPDATE "ai_drafts"
SET "status" = 'superseded'
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);--> statement-breakpoint

-- 7. At most one active draft per conversation.
CREATE UNIQUE INDEX "ai_drafts_active_per_conversation" ON "ai_drafts" USING btree ("conversation_id") WHERE status IN ('pending', 'ready');
