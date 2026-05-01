import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/(public)/privacy')({
  head: () => ({
    meta: [
      { title: 'プライバシーポリシー — Malbek' },
      { name: 'description', content: '株式会社Malbek のプライバシーポリシー' },
    ],
  }),
  component: PrivacyPage,
})

function PrivacyPage() {
  return (
    <main style={containerStyle}>
      <h1>プライバシーポリシー</h1>
      <p style={{ color: '#666' }}>最終更新日: 2026年5月1日</p>

      <p>
        株式会社Malbek（以下「当社」）は、Malbek Messenger Assistant（以下「本サービス」）において取得する個人情報の取り扱いについて、以下のとおりプライバシーポリシーを定めます。
      </p>

      <section>
        <h2>1. 取得するデータ項目</h2>
        <p>本サービスは、Meta（Facebook）の Messenger プラットフォームを通じて以下のデータを取得します。</p>
        <ul>
          <li>Messenger メッセージ本文</li>
          <li>送信者の Page-Scoped ID（PSID）</li>
          <li>Facebook ページ ID</li>
          <li>メッセージ送受信日時</li>
        </ul>
      </section>

      <section>
        <h2>2. 利用目的</h2>
        <p>取得したデータは、以下の目的にのみ使用します。</p>
        <ul>
          <li>カスタマーサポート業務の支援（オペレーターへの返信下書き生成）</li>
          <li>会話履歴の管理および表示</li>
          <li>サービス品質の改善</li>
        </ul>
      </section>

      <section>
        <h2>3. データの保存期間</h2>
        <p>
          メッセージデータおよびその関連情報は、本サービスの利用契約が有効である期間中保存します。
          契約終了後30日以内にデータを削除します。ユーザーからの削除依頼があった場合は、依頼受領後速やかに削除します。
        </p>
      </section>

      <section>
        <h2>4. 第三者へのデータ提供</h2>
        <p>
          当社は、<strong>AI による返信下書き生成</strong>のために、Messenger から受信したメッセージ本文を
          <strong>Anthropic, Inc.（米国）</strong>が提供する AI サービス（Claude）に送信します。
          Anthropic へのデータ送信は暗号化された通信（HTTPS）を通じて行われます。
          Anthropic のプライバシーポリシーは{' '}
          <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer">
            こちら
          </a>
          をご覧ください。
        </p>
        <p>
          上記以外の第三者へ個人データを提供することはありません（法令に基づく開示請求を除く）。
        </p>
      </section>

      <section>
        <h2>5. データ削除の依頼</h2>
        <p>
          Messenger を通じてやり取りされたデータの削除を希望される方は、
          <a href="/data-deletion">データ削除ページ</a>
          をご確認ください。Meta の仕様に基づくデータ削除コールバックにも対応しています。
        </p>
      </section>

      <section>
        <h2>6. お問い合わせ先</h2>
        <address style={{ fontStyle: 'normal' }}>
          <p>株式会社Malbek プライバシー担当</p>
          <p>〒150-0001 東京都渋谷区神宮前1-1-1</p>
          <p>
            メール:{' '}
            <a href="mailto:operator@malbek.co.jp">operator@malbek.co.jp</a>
          </p>
        </address>
      </section>

      <nav style={{ marginTop: '2rem', borderTop: '1px solid #eee', paddingTop: '1rem' }}>
        <a href="/">会社情報</a>
        {' | '}
        <a href="/terms">利用規約</a>
        {' | '}
        <a href="/data-deletion">データ削除</a>
      </nav>
    </main>
  )
}

const containerStyle: React.CSSProperties = {
  maxWidth: 800,
  margin: '0 auto',
  padding: '2rem 1rem',
  fontFamily: 'sans-serif',
  lineHeight: 1.8,
}
