# Contract: Settings の `translation_enabled` トグル + 取得 server fn 差分

**Files**:
- `app/src/routes/(app)/settings/-lib/list-settings.fn.ts`（spec 003 で導入、修正）
- `app/src/routes/(app)/settings/-lib/update-translation-toggle.fn.ts`（新規）
- `app/src/routes/(app)/settings/-components/TranslationToggle.tsx`（新規）

**Auth**: 既存セッション middleware。`withTenant(tenantId, fn)` 経由で RLS 適用。

---

## A. `listSettings` の差分（既存修正）

spec 003 の `listSettings` 返り値に `translationEnabled` を追加。

**変更後 Output**:
```ts
{
  pages: Array<{
    id: string,
    pageName: string,
    customPrompt: string | null,
  }>,
  translationEnabled: boolean,  // ← 新規
}
```

`SELECT translation_enabled FROM tenants WHERE id = current_tenant_id()` を 1 行追加するだけ。

---

## B. `updateTranslationToggle` server fn（新規）

### Input (Zod)

```ts
z.object({
  enabled: z.boolean(),
})
```

### Output

```ts
{
  ok: true,
  translationEnabled: boolean,
} | {
  ok: false,
  error: 'forbidden' | 'unexpected',
}
```

### 振る舞い

1. `withTenant(tenantId, async (tx) => { ... })` で開始
2. `UPDATE tenants SET translation_enabled = $enabled, updated_at=NOW() WHERE id=$tenantId`
3. ログイベント `translation_toggle_updated` 出力（`tenant_id`, `enabled`）
4. `{ ok: true, translationEnabled: enabled }` を返す

### エラー

- `forbidden`: tenant_id 解決失敗（middleware で 401/403 を返すべき、ここまで到達しない想定）
- `unexpected`: DB エラー

### クライアント側挙動

- 既存の AutoSave パターン（spec 003 で確立）を踏襲。トグル ON/OFF 直後に server fn を呼び、AutoSaveBadge で「保存しました」を表示
- レスポンスが `ok: false` ならトグル状態を元に戻す + エラートースト

---

## C. UI コンポーネント `TranslationToggle`

```tsx
type Props = {
  initialEnabled: boolean
}

// 振る舞い:
// - チェックボックス or トグルスイッチ
// - ラベル: m.settings_translation_label() (i18n)
// - 説明文: m.settings_translation_description() (i18n) — 「DeepL Free を使用、月 50 万文字まで」を含む
// - AutoSaveBadge を併置
```

### i18n キー

| キー | en | ja |
|---|---|---|
| `settings_translation_label` | "Show Japanese translation of drafts" | "ドラフトの日本語訳を表示" |
| `settings_translation_description` | "Translate AI drafts to Japanese for internal review. Uses DeepL Free (up to 500,000 chars/month)." | "AI ドラフトを内部確認用に日本語訳します。DeepL Free を使用（月 50 万文字まで）。" |
| `settings_translation_quota_warning` | "Translation quota for this month has been exhausted." | "今月の翻訳枠を使い切りました。" |

`settings_translation_quota_warning` は、過去 N 件の draft の `translation_status='failed'` が連続して発生し、かつログ集計で 456 が観測された場合に表示する将来オプション（本 spec では UI ノブを置くだけで実データ反映は spec 005 送り）。

---

## 観測性

| ログイベント | フィールド |
|---|---|
| `translation_toggle_updated` | `request_id`, `tenant_id`, `enabled` (boolean), `latency_ms` |

---

## テスト

| ケース | 期待 |
|---|---|
| 初期 false → true | DB 上で `translation_enabled=true`、再リロードで状態維持 |
| true → false | DB 上で `false`、過去の `translation_ja` は DB に残る（削除しない） |
| 他テナントの設定への影響 | RLS により tenant A の更新は tenant B の `translation_enabled` を変えない |
| listSettings が translation_enabled を返す | spec 003 までの既存項目（pages 配列）も同時に返る |
