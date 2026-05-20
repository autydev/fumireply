/**
 * E2E: Customer context & CustomerPanel — US2 scenario
 *
 * Pre-conditions (managed by CI via e2e.yml):
 *   - App running at APP_URL (default: http://localhost:3000)
 *   - Postgres seeded with test tenant + connected page + fixture conversation
 *     (conversation must exist in the DB for the thread route to load)
 *
 * Covers:
 *   - CustomerPanel visibility in thread view
 *   - Tone selection persists after reload
 *   - AutoSaveBadge transitions to "Saved" after tone selection
 *
 * Note: AI draft prompt verification (T031) is covered by the integration test
 * ai-draft-uses-conversation-settings.test.ts and does not require a live AI call here.
 */

import { test, expect } from '@playwright/test'

const REVIEWER_EMAIL    = process.env.E2E_REVIEWER_EMAIL    ?? 'reviewer@example.com'
const REVIEWER_PASSWORD = process.env.E2E_REVIEWER_PASSWORD ?? 'test-password'
const FIXTURE_THREAD_ID = process.env.E2E_FIXTURE_THREAD_ID ?? ''

// Skipped until E2E environment (seeding + e2e.yml) is fully provisioned.
// Re-enable by removing .skip once the prerequisites from review-flow.spec.ts are met.
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
