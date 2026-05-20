# Contract: ai-worker の翻訳分岐 + DeepL API 呼び出し

**File**: `ai-worker/src/translation.ts`（新規）+ `ai-worker/src/handler.ts`（修正）
**Trigger**: 既存の AI ドラフト生成 SQS ジョブの完了直後

## 振る舞い

ai-worker の draft job 処理フロー（spec 003 までの実装）末尾に翻訳分岐を追加する。

```
1. SQS メッセージ受信 (jobType='draft', draftId=...)
2. ↓ 既存処理: Anthropic 呼び出し → ai_drafts.body / status='ready' を書き込み
3. ↓ 新規追加: translateDraftIfEnabled(draftId, tenantId, draftBody, draftStatus)
4. ↓ メッセージ ACK
```

`translateDraftIfEnabled` のロジック:

```ts
async function translateDraftIfEnabled(
  draftId: string,
  tenantId: string,
  draftBody: string | null,
  draftStatus: 'pending' | 'ready' | 'failed',
): Promise<void> {
  // 1. draft 本体が失敗していたら翻訳しない
  if (draftStatus !== 'ready' || !draftBody) {
    await updateTranslationStatus(draftId, tenantId, 'skipped')
    return
  }

  // 2. テナントの translation_enabled を読む
  const enabled = await getTranslationEnabled(tenantId) // SELECT translation_enabled FROM tenants WHERE id=$1
  if (!enabled) {
    await updateTranslationStatus(draftId, tenantId, 'skipped')
    return
  }

  // 3. DeepL を呼ぶ
  try {
    const translation = await callDeepL(draftBody)
    await updateTranslation(draftId, tenantId, translation, 'ok')
  } catch (err) {
    logger.warn('deepl_failed', { draftId, tenantId, error: classifyDeepLError(err) })
    await updateTranslationStatus(draftId, tenantId, 'failed')
  }
}
```

## DeepL API 呼び出し

**Endpoint**: `https://api-free.deepl.com/v2/translate`
**Method**: POST
**Content-Type**: `application/x-www-form-urlencoded`
**Auth**: `Authorization: DeepL-Auth-Key {API_KEY}:fx`

**Body params**:
- `text=<draft body>`（URL エンコード）
- `target_lang=JA`
- `source_lang=EN`（簡略化のため固定。auto-detect の `source_lang` 未指定でも可だが、レスポンス時間がわずかに増える）

**Timeout**: 5 秒（AbortController で実装）

**期待レスポンス** (200):
```json
{
  "translations": [
    { "detected_source_language": "EN", "text": "..." }
  ]
}
```

**エラーレスポンス**:
| HTTP | 意味 | 扱い |
|---|---|---|
| 400 | リクエスト不正（target_lang など） | `failed`、ログに詳細 |
| 403 | 認証失敗（API キー不正） | `failed`、ログに詳細（運用ペンディング） |
| 429 | レート制限超過 | `failed`、ログ |
| 456 | 月次文字数上限超過 | `failed`、ログに `quota_exceeded=true` |
| 500/503 | DeepL 側障害 | `failed`、ログ |
| AbortError | タイムアウト | `failed`、ログに `timeout=true` |

## API キー取得

ai-worker 起動時または初回呼び出し時に SSM Parameter Store から取得しモジュールキャッシュ。spec 003 で確立した `getSsmParameter()` 関数を流用。

- SSM Path: `/fumireply/<env>/deepl_api_key`
- env var: `DEEPL_API_KEY_SSM_PATH` で path を渡す
- キャッシュ TTL: モジュールスコープ（Lambda コールドスタートで再取得）

## SQS メッセージ形式

**変更なし**。既存 draft job メッセージをそのまま受ける。translation_enabled の状態は ai-worker が DB から読むので、メッセージで渡さない（D-005 と整合）。

## 並行性

複数の ai-worker インスタンスが同時実行されても、`UPDATE ai_drafts SET translation_*` は対象 draft が異なるため衝突しない。DeepL API への並列呼び出しは特に制御せず、上限到達時に 456 で `failed` 化する自然な縮退に任せる。

## 観測性

| ログイベント | フィールド |
|---|---|
| `translation_skipped` | `draft_id`, `tenant_id`, `reason` (`'translation_disabled' | 'draft_failed'`) |
| `translation_started` | `draft_id`, `tenant_id`, `chars_input` |
| `translation_ok` | 上記 + `latency_ms`, `chars_billed` (response header `X-Billed-Characters` から) |
| `translation_failed` | 上記 + `http_status`, `error_class` (`'timeout' \| 'quota_exceeded' \| 'auth' \| 'other'`) |

## テスト

| ケース | 期待 |
|---|---|
| translation_enabled=true + DeepL 200 | DB に `translation_ja=*`, `translation_status='ok'` |
| translation_enabled=false | DeepL 呼び出しなし、`translation_status='skipped'` |
| translation_enabled=true + DeepL 456 | `translation_ja=NULL`, `translation_status='failed'` |
| translation_enabled=true + draft.status='failed' | DeepL 呼び出しなし、`translation_status='skipped'` |
| AbortController でタイムアウト発火 | `translation_status='failed'`、ログ `timeout=true` |
| DeepL API キー未設定（env 欠落） | 起動時にログで警告、translation_enabled=true でも全 `failed` |
