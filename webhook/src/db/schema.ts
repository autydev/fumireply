import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull().unique(),
    plan: varchar('plan', { length: 32 }).notNull().default('free'),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tenants_status_idx').on(t.status)],
)

export const connectedPages = pgTable(
  'connected_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    pageId: varchar('page_id', { length: 64 }).notNull().unique(),
    pageName: varchar('page_name', { length: 255 }).notNull(),
    pageAccessTokenEncrypted: bytea('page_access_token_encrypted').notNull(),
    webhookVerifyTokenSsmKey: varchar('webhook_verify_token_ssm_key', { length: 255 }).notNull(),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [index('connected_pages_tenant_id_idx').on(t.tenantId)],
)

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => connectedPages.id, { onDelete: 'restrict' }),
    customerPsid: varchar('customer_psid', { length: 64 }).notNull(),
    customerName: varchar('customer_name', { length: 255 }),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    unreadCount: integer('unread_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('conversations_page_id_customer_psid_key').on(t.pageId, t.customerPsid),
    index('conversations_tenant_id_last_message_at_idx').on(t.tenantId, t.lastMessageAt),
    index('conversations_tenant_id_idx').on(t.tenantId),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: varchar('direction', { length: 10 }).notNull(),
    metaMessageId: varchar('meta_message_id', { length: 128 }).unique(),
    body: text('body').notNull(),
    messageType: varchar('message_type', { length: 20 }).notNull().default('text'),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    sendStatus: varchar('send_status', { length: 20 }),
    sendError: text('send_error'),
    sentByAuthUid: uuid('sent_by_auth_uid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_tenant_id_conversation_id_timestamp_idx').on(
      t.tenantId,
      t.conversationId,
      t.timestamp,
    ),
    index('messages_tenant_id_idx').on(t.tenantId),
  ],
)

export const aiDrafts = pgTable(
  'ai_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    messageId: uuid('message_id')
      .notNull()
      .unique()
      .references(() => messages.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 20 }).notNull(),
    body: text('body'),
    model: varchar('model', { length: 64 }),
    error: text('error'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_drafts_tenant_id_idx').on(t.tenantId)],
)
