import { env } from '~/server/env'
import { getSsmParameter } from '~/server/services/ssm'
import { exchangeUserToken, listPages } from '~/server/services/facebook'
import { encryptToken, getMasterKey } from '~/server/services/crypto'

export type ExchangeAndListResult =
  | { ok: true; pages: Array<{ id: string; name: string }> }
  | {
      ok: false
      error: 'token_expired' | 'permission_missing' | 'no_pages' | 'rate_limited' | 'meta_unavailable' | 'internal_error'
      message: string
    }

export async function handleExchangeAndList(
  shortLivedUserToken: string,
): Promise<{ result: ExchangeAndListResult; encryptedLongToken?: Buffer }> {
  try {
    const appSecret = await getSsmParameter(env.META_APP_SECRET_SSM_KEY)
    const { accessToken: longToken } = await exchangeUserToken(
      shortLivedUserToken,
      env.META_APP_ID,
      appSecret,
    )

    const pages = await listPages(longToken)

    if (pages.length === 0) {
      return { result: { ok: false, error: 'no_pages', message: 'No Facebook Pages found.' } }
    }

    const masterKey = await getMasterKey()
    const encryptedLongToken = encryptToken(longToken, masterKey)

    return {
      result: { ok: true, pages: pages.map(({ id, name }) => ({ id, name })) },
      encryptedLongToken,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    if (msg === 'token_expired')
      return { result: { ok: false, error: 'token_expired', message: 'Token expired.' } }
    if (msg === 'permission_missing')
      return { result: { ok: false, error: 'permission_missing', message: 'Missing pages_show_list permission.' } }
    if (msg === 'rate_limited')
      return { result: { ok: false, error: 'rate_limited', message: 'Rate limited. Please wait.' } }
    if (msg === 'meta_unavailable')
      return { result: { ok: false, error: 'meta_unavailable', message: 'Facebook API unavailable.' } }
    return { result: { ok: false, error: 'internal_error', message: 'Internal error.' } }
  }
}
