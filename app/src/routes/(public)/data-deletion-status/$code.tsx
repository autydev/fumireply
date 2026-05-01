import { createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getDeletionStatusRecord } from './-lib/get-deletion-status'

const CONFIRMATION_CODE_PATTERN = /^[0-9a-fA-F]{32}$/

const getDeletionStatus = createServerFn({ method: 'GET' })
  .inputValidator((code: string) => {
    if (!CONFIRMATION_CODE_PATTERN.test(code)) throw notFound()
    return code
  })
  .handler(async ({ data: code }) => {
    return getDeletionStatusRecord(code)
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
