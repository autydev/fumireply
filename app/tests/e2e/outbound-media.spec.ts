/**
 * E2E: 010 outbound media — 添付ボタン表示 + client 検証エラー smoke (best-effort)
 *
 * Pre-conditions (managed by CI via e2e.yml, seed: src/server/db/seed/e2e.ts):
 *   - App running at APP_URL (default: http://localhost:3000)
 *   - MEDIA_BUCKET_NAME が設定済み (mediaUploadEnabled=true) で、24h ウィンドウ内の
 *     会話が seed されていること。
 *   - S3/LocalStack なしで成立するケースのみ扱う: (1) 📎 添付ボタンが表示される、
 *     (2) 対応外ファイルを選ぶと client 検証エラーが即出て S3 に進まない。
 *     実アップロード/送信は integration/unit テストで担保 (T011/T017/T022)。
 *
 * Covers SC 側の UI スモーク (添付導線 + client ガード)。
 *
 * Temporarily skipped: 既存 E2E 群 (review-flow / customer-context / media-attachments)
 * と同じく CI の seed + ログイン環境が未整備のため。再開時に describe.skip を外す。
 */

import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REVIEWER_EMAIL = process.env.E2E_REVIEWER_EMAIL ?? 'reviewer@example.com'
const REVIEWER_PASSWORD = process.env.E2E_REVIEWER_PASSWORD ?? 'test-password'

const here = dirname(fileURLToPath(import.meta.url))
// リポジトリ内の非画像ファイルを「対応外形式」の入力に使う (S3 に到達しない想定)。
const UNSUPPORTED_FILE = join(here, 'outbound-media.spec.ts')

test.describe.skip('outbound media — attach button & client validation (010)', () => {
  async function login(page: import('@playwright/test').Page) {
    await page.goto('/login')
    await page.getByLabel('Email').fill(REVIEWER_EMAIL)
    await page.getByLabel('Password').fill(REVIEWER_PASSWORD)
    await page.getByRole('button', { name: /login|ログイン/i }).click()
    await expect(page).toHaveURL(/\/inbox/)
    const firstConv = page.getByRole('link').first()
    await expect(firstConv).toBeVisible()
    await firstConv.click()
    await expect(page).toHaveURL(/\/threads\//)
  }

  test('shows the attach-image button when media upload is enabled', async ({ page }) => {
    await login(page)
    await expect(page.getByRole('button', { name: /画像を添付|attach image/i })).toBeVisible()
  })

  test('selecting an unsupported file shows a client validation error and does not upload', async ({
    page,
  }) => {
    await login(page)
    // 非表示の <input type="file"> に直接セットして client 検証を発火させる
    const input = page.locator('input[type="file"]')
    await input.setInputFiles(UNSUPPORTED_FILE)
    await expect(page.getByText(/対応していない画像形式|unsupported image format/i)).toBeVisible()
  })
})
