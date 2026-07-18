ALTER TABLE "messages" ADD COLUMN "attachments" jsonb;
--> statement-breakpoint
-- 009 FR-004a: 過去の inbound 画像は body に失効済みの Meta CDN URL を保存していた。
-- URL は復元不能 (Meta 側で再取得手段なし) のため一度の移行で本文を空にし、
-- UI 側が旧形式 (body=URL) を判定せずに済む新形式へ統一する。
UPDATE "messages" SET "body" = '' WHERE "message_type" = 'image' AND "body" LIKE 'http%';
