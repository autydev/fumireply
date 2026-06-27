// 006: postgres-js / drizzle がスローする UNIQUE 制約違反を判別するヘルパ。
// PostgreSQL の SQLSTATE 23505 (unique_violation) + 制約名一致で判定する。
//
// 用途: send-reply の `metaMessageId` 書き戻し時、echo が先着して同 mid の行を
// 既に作っているケースを catch して attribute 補正に分岐する (FR-008a)。
// 詳細は specs/006-message-echoes-ingest/contracts/echo-pipeline.md C4。

interface PgErrorLike {
  code?: unknown
  constraint_name?: unknown
}

export function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as PgErrorLike
  return e.code === '23505' && e.constraint_name === constraint
}

// drizzle が messages.metaMessageId に generate する UNIQUE 制約名。
// migrations/0000_ordinary_orphan.sql:64 に手動命名されている。
export const META_MESSAGE_ID_UNIQUE = 'messages_meta_message_id_unique'
