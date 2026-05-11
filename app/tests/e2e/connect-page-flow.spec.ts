/**
 * E2E: App Review — Connect Facebook Page flow (T040 / U4.1)
 *
 * Covers FR-001 (login), FR-006 (Connect Page UI), FR-007 (forward guard from
 * /inbox to /onboarding/connect-page when no row in connected_pages).
 *
 * Pre-conditions:
 *   - App running at APP_URL (default: http://localhost:3000)
 *   - Postgres seeded with a tenant + auth user but NO row in connected_pages
 *     (so the forward guard triggers)
 *   - Facebook Test User credentials provided via env:
 *       FB_TEST_USER_EMAIL — Test User email under Meta App Roles → Test Users
 *       FB_TEST_USER_PASSWORD — Test User password
 *       FB_TEST_PAGE_ID — Test Page name to click in PageList
 *
 * The whole suite is gated behind FB_TEST_USER_EMAIL because reviewers run it
 * during the App Review screencast prep, not on every CI run.
 */

import { test, expect } from '@playwright/test'

const REVIEWER_EMAIL = process.env.E2E_REVIEWER_EMAIL ?? 'reviewer@example.com'
const REVIEWER_PASSWORD = process.env.E2E_REVIEWER_PASSWORD ?? 'test-password'
const FB_TEST_USER_EMAIL = process.env.FB_TEST_USER_EMAIL
const FB_TEST_USER_PASSWORD = process.env.FB_TEST_USER_PASSWORD
const FB_TEST_PAGE_NAME = process.env.FB_TEST_PAGE_NAME

const shouldRun = Boolean(FB_TEST_USER_EMAIL && FB_TEST_USER_PASSWORD && FB_TEST_PAGE_NAME)

test.describe('connect facebook page flow', () => {
  test.skip(!shouldRun, 'Requires FB_TEST_USER_EMAIL / FB_TEST_USER_PASSWORD / FB_TEST_PAGE_NAME')

  test('login → forward-redirected to onboarding → FB.login → page selection → /inbox', async ({
    page,
    context,
  }) => {
    // 1. Operator logs in
    await page.goto('/login')
    await page.getByLabel(/email/i).fill(REVIEWER_EMAIL)
    await page.getByLabel(/password/i).fill(REVIEWER_PASSWORD)
    await page.getByRole('button', { name: /login|ログイン/i }).click()

    // 2. Forward guard kicks in: with empty connected_pages we land on onboarding
    await expect(page).toHaveURL(/\/onboarding\/connect-page/)
    await expect(page.getByRole('button', { name: /facebook/i })).toBeVisible()

    // 3. Trigger the FB.login popup, authenticate as the Test User, accept all 4
    //    permissions in a single dialog (auth_type=reauthenticate ensures the
    //    dialog appears every screencast take).
    const [fbPopup] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: /facebook/i }).click(),
    ])

    await fbPopup.waitForLoadState('domcontentloaded')
    await fbPopup.getByLabel(/email|電話番号/i).fill(FB_TEST_USER_EMAIL!)
    await fbPopup.getByLabel(/password|パスワード/i).fill(FB_TEST_USER_PASSWORD!)
    await fbPopup.getByRole('button', { name: /log in|ログイン/i }).click()

    // 4. Permissions dialog → accept all 4 permissions
    await fbPopup
      .getByRole('button', { name: /continue|許可|aceptar|continuar/i })
      .first()
      .click({ timeout: 30_000 })

    // 5. Back in the main page: PageList renders, choose the Test Page
    await expect(page.getByRole('heading', { name: /select|選択|page/i })).toBeVisible({
      timeout: 30_000,
    })
    await page.getByRole('button', { name: new RegExp(FB_TEST_PAGE_NAME!, 'i') }).click()

    // 6. After UPSERT we navigate to /inbox
    await expect(page).toHaveURL(/\/inbox/, { timeout: 30_000 })
  })

  test('reverse guard: revisiting onboarding after a page is connected redirects back to /inbox', async ({
    page,
  }) => {
    // Assumes the previous test (or a prep step) connected a page for this tenant.
    await page.goto('/login')
    await page.getByLabel(/email/i).fill(REVIEWER_EMAIL)
    await page.getByLabel(/password/i).fill(REVIEWER_PASSWORD)
    await page.getByRole('button', { name: /login|ログイン/i }).click()

    await expect(page).toHaveURL(/\/inbox/)

    // Now try to revisit /onboarding/connect-page directly: reverse guard should
    // bounce us back to /inbox.
    await page.goto('/onboarding/connect-page')
    await expect(page).toHaveURL(/\/inbox/)
  })
})
