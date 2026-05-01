import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/(public)/terms')({
  head: () => ({
    meta: [
      { title: '利用規約 — Malbek' },
      { name: 'description', content: '株式会社Malbek の利用規約' },
    ],
  }),
  component: TermsPage,
})

function TermsPage() {
  return (
    <main style={containerStyle}>
      <h1>利用規約</h1>
      <p style={{ color: '#666' }}>最終更新日: 2026年5月1日</p>

      <p>
        本利用規約（以下「本規約」）は、株式会社Malbek（以下「当社」）が提供する
        Malbek Messenger Assistant（以下「本サービス」）の利用条件を定めるものです。
        本サービスをご利用いただく前に、本規約をよくお読みください。
      </p>

      <section>
        <h2>第1条（適用）</h2>
        <p>
          本規約は、本サービスの利用に関する当社と利用者との間のすべての関係に適用されます。
          本サービスを利用した場合、本規約に同意したものとみなします。
        </p>
      </section>

      <section>
        <h2>第2条（サービスの内容）</h2>
        <p>
          本サービスは、Meta（Facebook）の Messenger プラットフォームを通じて受信した顧客メッセージを
          管理し、AI を用いた返信下書きの生成を支援するツールです。
          AI が生成した下書きは必ずオペレーターによる確認・承認を経て送信されます。
        </p>
      </section>

      <section>
        <h2>第3条（禁止事項）</h2>
        <p>利用者は、本サービスの利用にあたり、以下の行為を行ってはなりません。</p>
        <ul>
          <li>法令または公序良俗に違反する行為</li>
          <li>当社または第三者の知的財産権を侵害する行為</li>
          <li>当社のサーバーまたはネットワークの機能を妨害する行為</li>
          <li>不正アクセスまたはこれを試みる行為</li>
          <li>その他、当社が不適切と判断する行為</li>
        </ul>
      </section>

      <section>
        <h2>第4条（サービスの変更・停止）</h2>
        <p>
          当社は、利用者に事前に通知することなく、本サービスの内容を変更し、または本サービスの提供を
          停止することができます。当社は、これによって利用者に生じた損害について責任を負いません。
        </p>
      </section>

      <section>
        <h2>第5条（免責事項）</h2>
        <p>
          当社は、本サービスに事実上または法律上の瑕疵（安全性、信頼性、正確性、完全性、有効性、
          特定の目的への適合性、セキュリティなどに関する欠陥、エラーやバグ、権利侵害などを含みます）が
          ないことを明示的にも黙示的にも保証しておりません。
        </p>
        <p>
          本サービスによって利用者に生じたあらゆる損害について、当社の故意または重大な過失による場合を
          除き、当社は責任を負いません。
        </p>
      </section>

      <section>
        <h2>第6条（サービス利用料）</h2>
        <p>
          本サービスの利用料については、別途定める料金体系に従います。
          現在の MVP 期間中は審査目的での利用に限り提供されます。
        </p>
      </section>

      <section>
        <h2>第7条（準拠法・管轄裁判所）</h2>
        <p>
          本規約の解釈にあたっては、日本法を準拠法とします。
          本サービスに関して紛争が生じた場合には、岐阜地方裁判所を専属的合意管轄とします。
        </p>
      </section>

      <section>
        <h2>第8条（お問い合わせ）</h2>
        <address style={{ fontStyle: 'normal' }}>
          <p>株式会社Malbek</p>
          <p>〒503-2425 岐阜県揖斐郡池田町六之井1691-4</p>
          <p>
            メール:{' '}
            <a href="mailto:info@malbek.co.jp">info@malbek.co.jp</a>
          </p>
        </address>
      </section>

      <nav style={{ marginTop: '2rem', borderTop: '1px solid #eee', paddingTop: '1rem' }}>
        <a href="/">会社情報</a>
        {' | '}
        <a href="/privacy">プライバシーポリシー</a>
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
