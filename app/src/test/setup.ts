// aws-sdk-client-mock は .send() をモックするが、presigning (getSignedUrl) は
// 署名計算のため認証情報プロバイダチェーンを解決しようとする。CI には AWS 認証情報が
// 無いため、決定的なダミー認証情報を注入して実行環境に依存しないようにする。
// (実 AWS を叩くことはない — S3 呼び出し自体は aws-sdk-client-mock がインターセプトする)
process.env.AWS_ACCESS_KEY_ID = 'test-access-key-id'
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-access-key'
process.env.AWS_REGION ||= 'ap-northeast-1'

import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
