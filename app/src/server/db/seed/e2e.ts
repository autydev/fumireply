/**
 * E2E seed — local Playwright run 用
 *
 * 投入物:
 *   1. tenant (slug=e2e-tenant)
 *   2. Supabase auth ユーザー (reviewer@example.com / test-password,
 *      app_metadata: { tenant_id, role: 'reviewer' })
 *   3. connected_page (page_access_token_encrypted はダミーバイト列。
 *      E2E では Meta Send API をスタブする前提なので復号は要らない)
 *   4. conversation + inbound message 1 件
 *   5. ai_drafts (status='ready') — UI が即時 textarea に反映できる状態
 *
 * 必要な環境変数 (.env.local):
 *   - DATABASE_URL                — postgres 接続。RLS 越し用ではなく postgres superuser
 *   - SUPABASE_URL                — Supabase プロジェクト URL
 *   - SUPABASE_SECRET_KEY         — service_role secret (admin API 用)
 *
 * 任意の上書き:
 *   - E2E_REVIEWER_EMAIL / E2E_REVIEWER_PASSWORD
 *   - E2E_TENANT_SLUG / E2E_TENANT_NAME
 *   - E2E_PAGE_ID / E2E_PAGE_NAME
 *   - E2E_CUSTOMER_PSID / E2E_CUSTOMER_NAME
 *
 * 冪等: 既存レコードがあれば再利用 / 上書き。何度走らせても同じ最終状態に収束する。
 */
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import * as schema from '../schema'

const { tenants, connectedPages, conversations, messages, aiDrafts } = schema

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const supabaseUrl = process.env.SUPABASE_URL
  if (!supabaseUrl) throw new Error('SUPABASE_URL is required')

  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
  if (!supabaseSecretKey) {
    throw new Error('SUPABASE_SECRET_KEY (service_role) is required for auth.admin.createUser')
  }

  const reviewerEmail = process.env.E2E_REVIEWER_EMAIL ?? 'reviewer@example.com'
  const reviewerPassword = process.env.E2E_REVIEWER_PASSWORD ?? 'test-password'

  const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'e2e-tenant'
  const tenantName = process.env.E2E_TENANT_NAME ?? 'E2E Tenant'

  const pageId = process.env.E2E_PAGE_ID ?? 'e2e-page-0001'
  const pageName = process.env.E2E_PAGE_NAME ?? 'E2E Test Page'

  const customerPsid = process.env.E2E_CUSTOMER_PSID ?? '1000000000000001'
  const customerName = process.env.E2E_CUSTOMER_NAME ?? 'テストユーザー太郎'

  const sql = postgres(databaseUrl, { prepare: false })
  const db = drizzle(sql, { schema })
  const supabase = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 1. tenant
  console.log(`[1/5] tenant: ${tenantSlug}`)
  let tenantRow = (
    await db
      .insert(tenants)
      .values({ slug: tenantSlug, name: tenantName, plan: 'free', status: 'active' })
      .onConflictDoNothing()
      .returning()
  )[0]
  if (!tenantRow) {
    tenantRow = (
      await db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1)
    )[0]
  }
  if (!tenantRow) throw new Error(`tenant ${tenantSlug} not found after upsert`)
  const tenantId = tenantRow.id
  console.log(`      tenantId=${tenantId}`)

  // 2. reviewer user (Supabase auth)
  console.log(`[2/5] reviewer auth user: ${reviewerEmail}`)
  // listUsers でメール一致を探す。perPage=200 まで。MVP テスト DB なら十分。
  const { data: list, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 200 })
  if (listErr) throw new Error(`listUsers failed: ${listErr.message}`)
  const existingUser = list.users.find((u) => u.email === reviewerEmail)
  let userId: string
  if (existingUser) {
    const { error } = await supabase.auth.admin.updateUserById(existingUser.id, {
      password: reviewerPassword,
      email_confirm: true,
      app_metadata: {
        ...(existingUser.app_metadata ?? {}),
        tenant_id: tenantId,
        role: 'reviewer',
      },
    })
    if (error) throw new Error(`updateUserById failed: ${error.message}`)
    userId = existingUser.id
    console.log(`      reused user: ${userId}`)
  } else {
    const { data: created, error } = await supabase.auth.admin.createUser({
      email: reviewerEmail,
      password: reviewerPassword,
      email_confirm: true,
      app_metadata: { tenant_id: tenantId, role: 'reviewer' },
    })
    if (error || !created.user) throw new Error(`createUser failed: ${error?.message}`)
    userId = created.user.id
    console.log(`      created user: ${userId}`)
  }

  // 3. connected_page
  console.log(`[3/5] connected_page: ${pageId}`)
  let pageRow = (
    await db
      .insert(connectedPages)
      .values({
        tenantId,
        pageId,
        pageName,
        // ダミーバイト列。E2E では Meta Send API をスタブする前提のため復号は走らない。
        // 12B IV + 16B tag + N (ここでは 32B) の体裁だけ合わせておく。
        pageAccessTokenEncrypted: randomBytes(60),
        webhookVerifyTokenSsmKey: '/fumireply/e2e/meta/webhook-verify-token',
      })
      .onConflictDoNothing()
      .returning()
  )[0]
  if (!pageRow) {
    pageRow = (
      await db
        .select()
        .from(connectedPages)
        .where(eq(connectedPages.pageId, pageId))
        .limit(1)
    )[0]
  }
  if (!pageRow) throw new Error(`connected_page ${pageId} not found after upsert`)
  const connectedPageId = pageRow.id
  console.log(`      connectedPageId=${connectedPageId}`)

  // 4. conversation + inbound message
  // 同一 (page_id, customer_psid) の既存会話があれば削除してから作り直す
  // (messages / ai_drafts は cascade で消える)。冪等な「最新状態」を保証するため。
  console.log(`[4/5] conversation: psid=${customerPsid}`)
  await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.pageId, connectedPageId),
        eq(conversations.customerPsid, customerPsid),
      ),
    )

  const now = new Date()
  const inboundAt = new Date(now.getTime() - 5 * 60 * 1000) // 5 分前 → 24h 窓内

  const [conv] = await db
    .insert(conversations)
    .values({
      tenantId,
      pageId: connectedPageId,
      customerPsid,
      customerName,
      lastInboundAt: inboundAt,
      lastMessageAt: inboundAt,
      unreadCount: 1,
    })
    .returning()
  if (!conv) throw new Error('conversation insert returned no row')

  const [inboundMsg] = await db
    .insert(messages)
    .values({
      tenantId,
      conversationId: conv.id,
      direction: 'inbound',
      metaMessageId: `e2e-inbound-${Date.now()}`,
      body: 'こんにちは、商品の在庫状況を教えていただけますか？',
      messageType: 'text',
      timestamp: inboundAt,
    })
    .returning()
  if (!inboundMsg) throw new Error('message insert returned no row')
  console.log(`      conversationId=${conv.id}, inboundMessageId=${inboundMsg.id}`)

  // 5. ai_drafts (status='ready') — ReplyForm が即時 textarea にプリフィルする
  console.log(`[5/5] ai_drafts (status=ready)`)
  await db.insert(aiDrafts).values({
    tenantId,
    messageId: inboundMsg.id,
    status: 'ready',
    body: 'お問い合わせありがとうございます。在庫状況を確認のうえ、改めてご連絡いたします。',
    model: 'claude-sonnet-4-6',
    promptTokens: 50,
    completionTokens: 80,
    latencyMs: 1200,
  })

  console.log('\nE2E seed complete.')
  console.log(`  Login : ${reviewerEmail} / ${reviewerPassword}`)
  console.log(`  Tenant: ${tenantSlug} (${tenantId})`)
  console.log(`  Page  : ${pageName} (${pageId})`)

  await sql.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
