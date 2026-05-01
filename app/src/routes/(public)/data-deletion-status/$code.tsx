import { createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { dbAdmin } from '~/server/db/client'
import { deletionLog } from '~/server/db/schema'

const getDeletionStatus = createServerFn({ method: 'GET' })
  .inputValidator((code: string) => code)
  .handler(async ({ data: code }) => {
    // Service role bypasses RLS — status endpoint is public and tenant-agnostic
    const rows = await dbAdmin
      .select({
        confirmationCode: deletionLog.confirmationCode,
        deletedAt: deletionLog.deletedAt,
      })
      .from(deletionLog)
      .where(eq(deletionLog.confirmationCode, code))

    return rows[0] ?? null
  })

export const Route = createFileRoute('/(public)/data-deletion-status/$code')({
  loader: async ({ params }) => {
    const entry = await getDeletionStatus({ data: params.code })
    if (!entry) throw notFound()
    return entry
  },
  notFoundComponent: NotFoundPage,
  component: DataDeletionStatusPage,
})

function DataDeletionStatusPage() {
  const { confirmationCode, deletedAt } = Route.useLoaderData()
  const deletedAtStr = new Date(deletedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

  return (
    <main style={{ fontFamily: 'sans-serif', maxWidth: '600px', margin: '40px auto', padding: '0 16px' }}>
      <h1>Data Deletion Confirmed / データ削除完了</h1>
      <p>
        Your customer data associated with this confirmation code has been permanently deleted from
        our system.
      </p>
      <p>
        このコードに紐づくお客様データは当社システムから完全に削除されました。
      </p>
      <dl>
        <dt>
          <strong>Deleted at / 削除日時</strong>
        </dt>
        <dd>{deletedAtStr}</dd>
        <dt>
          <strong>Confirmation Code / 確認コード</strong>
        </dt>
        <dd>
          <code>{confirmationCode}</code>
        </dd>
      </dl>
      <p>
        If you have questions, please contact:{' '}
        <a href="mailto:support@malbek.co.jp">support@malbek.co.jp</a>
      </p>
    </main>
  )
}

function NotFoundPage() {
  return (
    <main style={{ fontFamily: 'sans-serif', maxWidth: '600px', margin: '40px auto', padding: '0 16px' }}>
      <h1>Not found / 見つかりません</h1>
      <p>The confirmation code you provided was not found in our system.</p>
      <p>ご提供の確認コードはシステムに見つかりませんでした。</p>
    </main>
  )
}
