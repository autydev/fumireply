/**
 * E2E: Meta App Review — core reviewer flow
 *
 * Pre-conditions (managed by CI via e2e.yml):
 *   - App running at APP_URL (default: http://localhost:8080)
 *   - Postgres seeded with test tenant + connected page + fixture conversation
 *   - AI draft service mocked to respond immediately (status='ready')
 *
 * Covers FR-001 (login), FR-002 (inbox), FR-003 (thread detail),
 * FR-004 (AI draft display), FR-005 (edit + send reply)
 */

import { test, expect } from '@playwright/test'

const REVIEWER_EMAIL = process.env.E2E_REVIEWER_EMAIL ?? 'reviewer@example.com'
const REVIEWER_PASSWORD = process.env.E2E_REVIEWER_PASSWORD ?? 'test-password'

test.describe('reviewer flow', () => {
  test('login → inbox → thread → AI draft → reply → success', async ({ page }) => {
    // 1. Login
    await page.goto('/login')
    await page.getByLabel('メールアドレス').fill(REVIEWER_EMAIL)
    await page.getByLabel('パスワード').fill(REVIEWER_PASSWORD)
    await page.getByRole('button', { name: 'ログイン' }).click()

    // 2. Redirected to inbox
    await expect(page).toHaveURL(/\/inbox/)
    await expect(page.getByRole('heading', { name: /inbox/i })).toBeVisible()

    // 3. Click first conversation
    const firstConv = page.locator('[data-testid="conversation-item"]').first()
    await expect(firstConv).toBeVisible()
    await firstConv.click()

    // 4. Thread detail page loaded
    await expect(page).toHaveURL(/\/threads\//)
    await expect(page.locator('.reply-textarea')).toBeVisible()

    // 5. AI draft banner appears (mocked to return 'ready' immediately)
    // Poll for draft ready status (DraftBanner uses 3-second polling interval in tests)
    const draftBanner = page.locator('[role="status"]').filter({ hasText: /AI 下書き/ })
    await expect(draftBanner).toBeVisible({ timeout: 15_000 })

    // 6. Edit the reply text
    const textarea = page.locator('.reply-textarea')
    await textarea.clear()
    await textarea.fill('テスト返信メッセージ')

    // 7. Submit reply (MSW mocks Meta Send API to return success)
    await page.getByRole('button', { name: '送信' }).click()

    // 8. Success state: sent indicator visible
    await expect(page.locator('[aria-label*="sent"]').or(page.locator('[aria-label*="送信済"]'))).toBeVisible({
      timeout: 10_000,
    })
  })

  test('logout: clears session and redirects to login', async ({ page }) => {
    // Login first
    await page.goto('/login')
    await page.getByLabel('メールアドレス').fill(REVIEWER_EMAIL)
    await page.getByLabel('パスワード').fill(REVIEWER_PASSWORD)
    await page.getByRole('button', { name: 'ログイン' }).click()
    await expect(page).toHaveURL(/\/inbox/)

    // Logout
    const logoutBtn = page.getByRole('button', { name: 'ログアウト' })
    if (await logoutBtn.isVisible()) {
      await logoutBtn.click()
    } else {
      // Logout may be in a menu
      await page.goto('/logout')
    }

    await expect(page).toHaveURL(/\/login/)
  })

  test('unauthenticated: /inbox redirects to /login', async ({ page }) => {
    await page.goto('/inbox')
    await expect(page).toHaveURL(/\/login/)
  })

  test('public pages: accessible without login', async ({ page }) => {
    for (const path of ['/privacy', '/terms', '/data-deletion', '/']) {
      await page.goto(path)
      await expect(page).not.toHaveURL(/\/login/)
    }
  })
})
