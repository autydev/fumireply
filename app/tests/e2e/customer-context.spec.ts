/**
 * E2E: Customer Context & Settings — US1 Settings page
 *
 * Pre-conditions (managed by CI via e2e.yml):
 *   - App running at APP_URL (default: http://localhost:3000)
 *   - Postgres seeded with test tenant + at least one connected page
 *
 * Covers US1: Settings 画面でページカスタムプロンプトを保存・永続化できること
 *
 * Temporarily skipped: E2E 環境（operator ユーザーの seed、connected_page 投入、
 * CI workflow）が未整備のため。US2 / US3 テストはこのファイルに追記予定。
 */

import { test, expect } from '@playwright/test'

const OPERATOR_EMAIL = process.env.E2E_OPERATOR_EMAIL ?? 'operator@example.com'
const OPERATOR_PASSWORD = process.env.E2E_OPERATOR_PASSWORD ?? 'test-password'

test.describe.skip('Settings page — US1 page custom prompt', () => {
  test('login → sidebar Settings → /settings → edit custom prompt → autosave → persist on reload', async ({
    page,
  }) => {
    // 1. Login
    await page.goto('/login')
    await page.getByLabel('Email').fill(OPERATOR_EMAIL)
    await page.getByLabel('Password').fill(OPERATOR_PASSWORD)
    await page.getByRole('button', { name: /login/i }).click()

    // 2. Should land on /inbox (onboarding guard passes because page is connected)
    await expect(page).toHaveURL(/\/inbox/)

    // 3. Click Settings in sidebar
    await page.getByRole('link', { name: /settings/i }).click()
    await expect(page).toHaveURL(/\/settings/)

    // 4. Settings page renders with at least one PageCustomPromptEditor
    await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible()
    const textarea = page.locator('textarea').first()
    await expect(textarea).toBeVisible()

    // 5. Type text → AutoSaveBadge shows "Saved"
    const testText = `E2E test prompt ${Date.now()}`
    await textarea.fill(testText)
    // AutoSaveBadge transitions editing → saving → saved (debounce 500ms + network)
    await expect(page.getByText(/saved/i)).toBeVisible({ timeout: 5000 })

    // 6. Reload → text persists
    await page.reload()
    await expect(page).toHaveURL(/\/settings/)
    const reloadedTextarea = page.locator('textarea').first()
    await expect(reloadedTextarea).toHaveValue(testText)
  })
})
