import {
  exchangeUserToken,
  listPages,
  type ExchangeUserTokenResult,
  type ListPagesResult,
} from '~/server/services/facebook'

export type ExchangeAndListSuccess = {
  ok: true
  pages: Array<{ id: string; name: string; pageAccessToken: string }>
}

export type ExchangeAndListFailure = {
  ok: false
  error:
    | 'token_expired'
    | 'permission_missing'
    | 'no_pages'
    | 'rate_limited'
    | 'meta_unavailable'
    | 'internal_error'
  message: string
}

export type ExchangeAndListResult = ExchangeAndListSuccess | ExchangeAndListFailure

const ERROR_MESSAGE: Record<ExchangeAndListFailure['error'], string> = {
  token_expired: 'onboarding_error_token_expired',
  permission_missing: 'onboarding_error_permission_missing',
  no_pages: 'onboarding_no_pages',
  rate_limited: 'onboarding_error_rate_limited',
  meta_unavailable: 'onboarding_error_meta_unavailable',
  internal_error: 'onboarding_error_generic',
}

function failure(error: ExchangeAndListFailure['error']): ExchangeAndListFailure {
  return { ok: false, error, message: ERROR_MESSAGE[error] }
}

export async function handleExchangeAndList(
  shortLivedUserToken: string,
  deps: {
    exchangeUserToken: typeof exchangeUserToken
    listPages: typeof listPages
  } = { exchangeUserToken, listPages },
): Promise<ExchangeAndListResult> {
  const exchangeResult: ExchangeUserTokenResult = await deps.exchangeUserToken(shortLivedUserToken)
  if (!exchangeResult.ok) {
    if (exchangeResult.error === 'token_expired') return failure('token_expired')
    if (exchangeResult.error === 'rate_limited') return failure('rate_limited')
    if (exchangeResult.error === 'meta_unavailable') return failure('meta_unavailable')
    return failure('internal_error')
  }

  const listResult: ListPagesResult = await deps.listPages(exchangeResult.longLivedUserToken)
  if (!listResult.ok) {
    if (listResult.error === 'token_expired') return failure('token_expired')
    if (listResult.error === 'permission_missing') return failure('permission_missing')
    if (listResult.error === 'rate_limited') return failure('rate_limited')
    if (listResult.error === 'meta_unavailable') return failure('meta_unavailable')
    return failure('internal_error')
  }

  if (listResult.pages.length === 0) return failure('no_pages')

  return {
    ok: true,
    pages: listResult.pages.map((p) => ({
      id: p.id,
      name: p.name,
      pageAccessToken: p.pageAccessToken,
    })),
  }
}
