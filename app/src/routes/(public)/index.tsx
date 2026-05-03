import { createFileRoute } from '@tanstack/react-router'
import { PublicShell } from './-components/PublicShell'

export const Route = createFileRoute('/(public)/')({
  head: () => ({
    meta: [
      { title: 'Fumireply — 会社情報' },
      { name: 'description', content: '株式会社Malbek の会社情報ページ' },
    ],
  }),
  component: CompanyPage,
})

function CompanyPage() {
  return (
    <PublicShell>
      <main className="public-page">
        <h1>株式会社Malbek</h1>

        <section>
          <h2>会社概要</h2>
          <table>
            <tbody>
              <tr>
                <th scope="row">会社名</th>
                <td>株式会社Malbek</td>
              </tr>
              <tr>
                <th scope="row">所在地</th>
                <td>〒503-2425 岐阜県揖斐郡池田町六之井1691-4</td>
              </tr>
              <tr>
                <th scope="row">メールアドレス</th>
                <td>
                  <a href="mailto:info@malbek.co.jp">info@malbek.co.jp</a>
                </td>
              </tr>
              <tr>
                <th scope="row">事業内容</th>
                <td>越境 EC および EC 支援ツールの開発</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h2>提供サービス</h2>
          <p>
            <strong>Fumireply</strong> は、Meta（Facebook / Instagram）の Messenger
            プラットフォームに届く顧客メッセージを管理し、AI による返信下書きで
            カスタマーサポート業務を半自動化するツールです。
          </p>
        </section>
      </main>
    </PublicShell>
  )
}
