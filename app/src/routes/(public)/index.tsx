import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/(public)/')({
  head: () => ({
    meta: [
      { title: 'Malbek — 会社情報' },
      { name: 'description', content: '株式会社Malbek の会社情報ページ' },
    ],
  }),
  component: CompanyPage,
})

function CompanyPage() {
  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '2rem 1rem', fontFamily: 'sans-serif' }}>
      <h1>株式会社Malbek</h1>

      <section style={{ marginTop: '2rem' }}>
        <h2>会社概要</h2>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            <tr>
              <th style={thStyle}>会社名</th>
              <td style={tdStyle}>株式会社Malbek</td>
            </tr>
            <tr>
              <th style={thStyle}>所在地</th>
              <td style={tdStyle}>〒150-0001 東京都渋谷区神宮前1-1-1</td>
            </tr>
            <tr>
              <th style={thStyle}>電話番号</th>
              <td style={tdStyle}>03-6000-0000</td>
            </tr>
            <tr>
              <th style={thStyle}>メールアドレス</th>
              <td style={tdStyle}>
                <a href="mailto:operator@malbek.co.jp">operator@malbek.co.jp</a>
              </td>
            </tr>
            <tr>
              <th style={thStyle}>事業内容</th>
              <td style={tdStyle}>Messenger を活用した顧客サポート支援サービスの提供</td>
            </tr>
          </tbody>
        </table>
      </section>

      <nav style={{ marginTop: '2rem', display: 'flex', gap: '1rem' }}>
        <a href="/privacy">プライバシーポリシー</a>
        <a href="/terms">利用規約</a>
        <a href="/data-deletion">データ削除</a>
      </nav>
    </main>
  )
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.5rem 1rem 0.5rem 0',
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
  width: '160px',
}

const tdStyle: React.CSSProperties = {
  padding: '0.5rem 0',
}
