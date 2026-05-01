import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/(public)/data-deletion')({
  head: () => ({
    meta: [
      { title: 'データ削除 — Malbek' },
      { name: 'description', content: 'Malbek Messenger Assistant のユーザーデータ削除手順' },
    ],
  }),
  component: DataDeletionPage,
})

function DataDeletionPage() {
  return (
    <main style={containerStyle}>
      <h1>ユーザーデータ削除</h1>
      <p style={{ color: '#666' }}>最終更新日: 2026年5月1日</p>

      <p>
        本ページでは、Malbek Messenger Assistant（以下「本サービス」）が保有するあなたのデータを
        削除する方法を説明します。
      </p>

      <section>
        <h2>削除対象のデータ</h2>
        <p>削除リクエストを受け付けた場合、以下のデータをすべて削除します。</p>
        <ul>
          <li>Messenger メッセージ本文</li>
          <li>会話履歴</li>
          <li>AI が生成した返信下書き（ai_drafts）</li>
          <li>送信者の Page-Scoped ID（PSID）に紐づくすべての記録</li>
        </ul>
        <p>
          削除の完了後、削除受付記録（psid をハッシュ化したもの、削除日時、確認コード）のみを監査目的で保持します。
          平文の PSID やメッセージ本文は削除受付時に破棄されます。
        </p>
      </section>

      <section>
        <h2>削除依頼の方法</h2>

        <h3>方法1: Meta を通じた自動削除（推奨）</h3>
        <p>
          本サービスは Meta のデータ削除コールバック仕様に対応しています。
          Meta の「あなたのFacebook情報」ページから「アプリとウェブサイト」を選択し、
          「Malbek Messenger Assistant」を削除することで、自動的に削除リクエストが送信されます。
        </p>
        <p>
          削除リクエストを受信すると、当社のシステムが自動的に上記のデータ削除処理を行います。
          削除完了後、確認コードが発行されます。確認コードをお持ちの方は、以下の URL で削除状況を確認できます:
        </p>
        <p>
          <code>https://review.malbek.co.jp/api/data-deletion/status/&lt;確認コード&gt;</code>
        </p>

        <h3>方法2: メールによる手動依頼</h3>
        <p>
          Meta のアプリ削除から自動リクエストが送信されない場合は、以下にメールにてご連絡ください。
        </p>
        <address style={{ fontStyle: 'normal', background: '#f5f5f5', padding: '1rem', borderRadius: 4 }}>
          <p>
            <strong>件名:</strong> データ削除依頼
          </p>
          <p>
            <strong>宛先:</strong>{' '}
            <a href="mailto:operator@malbek.co.jp">operator@malbek.co.jp</a>
          </p>
          <p>
            <strong>本文に記載いただく内容:</strong>
          </p>
          <ul>
            <li>依頼者のお名前またはアカウント識別情報</li>
            <li>対象の Facebook ページ名</li>
            <li>削除を希望するデータの種類（全データ削除を希望する旨）</li>
          </ul>
        </address>
        <p>
          メール受領後、5営業日以内に削除処理を行い、完了の旨をご返信します。
        </p>
      </section>

      <section>
        <h2>データ削除コールバックエンドポイント（開発者向け）</h2>
        <p>
          Meta App Dashboard への登録エンドポイントは以下のとおりです:
        </p>
        <ul>
          <li>
            <strong>削除リクエスト受信:</strong>{' '}
            <code>POST https://review.malbek.co.jp/api/data-deletion</code>
          </li>
          <li>
            <strong>削除ステータス確認:</strong>{' '}
            <code>GET https://review.malbek.co.jp/api/data-deletion/status/:code</code>
          </li>
        </ul>
        <p>
          リクエストは Meta の signed_request 仕様（HMAC-SHA256）に基づいて検証されます。
        </p>
      </section>

      <nav style={{ marginTop: '2rem', borderTop: '1px solid #eee', paddingTop: '1rem' }}>
        <a href="/">会社情報</a>
        {' | '}
        <a href="/privacy">プライバシーポリシー</a>
        {' | '}
        <a href="/terms">利用規約</a>
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
