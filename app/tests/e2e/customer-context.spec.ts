/**
 * E2E: Customer Context & Settings — US1 Settings page + US2 CustomerPanel
 *
 * Pre-conditions (managed by CI via e2e.yml):
 *   - App running at APP_URL (default: http://localhost:3000)
 *   - Postgres seeded with test tenant + connected page + fixture conversation
 *
 * Covers:
 *   - US1: Settings 画面でページカスタムプロンプトを保存・永続化できること
 *   - US2: CustomerPanel visibility, tone selection persistence, toggle
 *
 * Note: AI draft prompt verification (T031) is covered by the integration test
 * ai-draft-uses-conversation-settings.test.ts and does not require a live AI call here.
 *
 * Temporarily skipped: E2E 環境（seed、CI workflow）が未整備のため。
 */

import { test, expect } from '@playwright/test'

const OPERATOR_EMAIL    = process.env.E2E_OPERATOR_EMAIL    ?? 'operator@example.com'
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? 'test-password'
const REVIEWER_EMAIL    = process.env.E2E_REVIEWER_EMAIL    ?? 'reviewer@example.com'
const REVIEWER_PASSWORD = process.env.E2E_REVIEWER_PASSWORD ?? 'test-password'
const FIXTURE_THREAD_ID = process.env.E2E_FIXTURE_THREAD_ID ?? ''

// US1 — Settings page
test.describe.skip('Settings page — US1 page custom prompt', () => {
  test('login → sidebar Settings → /settings → edit custom prompt → autosave → persist on reload', async ({
    page,
  }) => {
    // 1. Login — use regex selectors to be locale-agnostic
    await page.goto('/login')
    await page.getByLabel(/email|メール/i).fill(OPERATOR_EMAIL)
    await page.getByLabel(/password|パスワード/i).fill(OPERATOR_PASSWORD)
    await page.getByRole('button', { name: /login|ログイン/i }).click()

    // 2. Should land on /inbox (onboarding guard passes because page is connected)
    await expect(page).toHaveURL(/\/inbox/)

    // 3. Click Settings in sidebar — nav_settings is "Settings" (en) / "設定" (ja)
    await page.getByRole('link', { name: /settings|設定/i }).click()
    await expect(page).toHaveURL(/\/settings/)

    // 4. Settings page renders with at least one PageCustomPromptEditor
    await expect(page.getByRole('heading', { name: /settings|設定/i })).toBeVisible()
    const textarea = page.locator('textarea').first()
    await expect(textarea).toBeVisible()

    // 5. Type text → AutoSaveBadge shows "Saved" / "保存済み"
    const testText = `E2E test prompt ${Date.now()}`
    await textarea.fill(testText)
    // AutoSaveBadge transitions editing → saving → saved (debounce 500ms + network)
    await expect(page.getByText(/saved|保存済み/i)).toBeVisible({ timeout: 5000 })

    // 6. Reload → text persists
    await page.reload()
    await expect(page).toHaveURL(/\/settings/)
    const reloadedTextarea = page.locator('textarea').first()
    await expect(reloadedTextarea).toHaveValue(testText)
  })
})

// US2 — CustomerPanel
test.describe.skip('CustomerPanel — US2', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(REVIEWER_EMAIL)
    await page.getByLabel('Password').fill(REVIEWER_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL('**/inbox')
  })

  test('CustomerPanel is visible when opening a thread', async ({ page }) => {
    await page.goto(`/threads/${FIXTURE_THREAD_ID}`)
    await page.waitForLoadState('networkidle')

    // CustomerPanel should be visible by default (localStorage default = open)
    const panel = page.locator('.customer-panel')
    await expect(panel).toBeVisible()

    // Header should show customer name or PSID
    await expect(panel).not.toBeEmpty()
  })

  test('selecting Concise tone → AutoSaveBadge shows Saved → persists on reload', async ({ page }) => {
    await page.goto(`/threads/${FIXTURE_THREAD_ID}`)
    await page.waitForLoadState('networkidle')

    // Click Concise tone button
    await page.getByRole('button', { name: /concise/i }).click()

    // AutoSaveBadge should eventually show "Saved" (or Japanese equivalent)
    await expect(
      page.locator('[aria-live="polite"]').filter({ hasText: /saved|保存済み/i }),
    ).toBeVisible({ timeout: 3000 })

    // Reload and verify tone selection persists
    await page.reload()
    await page.waitForLoadState('networkidle')

    const conciseButton = page.getByRole('button', { name: /concise/i })
    await expect(conciseButton).toHaveAttribute('style', /var\(--color-accent\)/)
  })

  test('toggle button hides and shows CustomerPanel', async ({ page }) => {
    await page.goto(`/threads/${FIXTURE_THREAD_ID}`)
    await page.waitForLoadState('networkidle')

    const panel = page.locator('.customer-panel')

    // Hide panel
    await page.getByRole('button', { name: /hide customer panel|顧客パネルを隠す/i }).click()
    await expect(panel).toHaveClass(/customer-panel--hidden/)

    // Show panel again
    await page.getByRole('button', { name: /show customer panel|顧客パネルを表示/i }).click()
    await expect(panel).not.toHaveClass(/customer-panel--hidden/)
  })
})
