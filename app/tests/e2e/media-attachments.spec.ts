/**
 * E2E: 009 media attachments — placeholder / type-label smoke
 *
 * Pre-conditions (managed by CI via e2e.yml, seed: src/server/db/seed/e2e.ts):
 *   - App running at APP_URL (default: http://localhost:3000)
 *   - Seed inserts a conversation with:
 *       - image message with attachments=[{ type: 'image', s3Key: null }] → 「画像(取得不可)」
 *       - sticker message with attachments=[{ type: 'sticker', s3Key: null }] → 「スタンプ」
 *   - presign 不要なケースのみ扱う (S3/LocalStack なしで成立する)。
 *     保存済み画像の <img> 描画は integration/unit テストで担保。
 *
 * Covers SC-002 (生 URL 表示 0 件) / SC-003 (空バブル 0 件) の UI 側スモーク。
 *
 * Temporarily skipped: 既存 E2E 群 (review-flow / customer-context) と同じく
 * CI の seed + ログイン環境が未整備のため。再開時に describe.skip を外す。
 */

import { test, expect } from '@playwright/test'

const REVIEWER_EMAIL = process.env.E2E_REVIEWER_EMAIL ?? 'reviewer@example.com'
const REVIEWER_PASSWORD = process.env.E2E_REVIEWER_PASSWORD ?? 'test-password'

test.describe.skip('media attachments — placeholder & labels (009)', () => {
  test('thread shows placeholder for unavailable image and label for sticker, no raw URLs / empty bubbles', async ({
    page,
  }) => {
    // 1. Login
    await page.goto('/login')
    await page.getByLabel('Email').fill(REVIEWER_EMAIL)
    await page.getByLabel('Password').fill(REVIEWER_PASSWORD)
    await page.getByRole('button', { name: /login|ログイン/i }).click()

    // 2. Open the seeded conversation
    await expect(page).toHaveURL(/\/inbox/)
    const firstConv = page.getByRole('link').first()
    await expect(firstConv).toBeVisible()
    await firstConv.click()
    await expect(page).toHaveURL(/\/threads\//)

    // 3. 取得不可画像はプレースホルダ表示 (SC-003: 空バブルにしない)
    await expect(page.getByText('画像(取得不可)')).toBeVisible()

    // 4. スタンプは種別ラベル表示
    await expect(page.getByText('スタンプ')).toBeVisible()

    // 5. SC-002: 生の CDN URL 文字列がバブルに出ていない
    await expect(page.locator('li', { hasText: 'https://' })).toHaveCount(0)
  })
})
