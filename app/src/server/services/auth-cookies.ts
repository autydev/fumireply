import { setCookie } from '@tanstack/react-start/server'

export const ACCESS_COOKIE = 'sb-access-token'
export const REFRESH_COOKIE = 'sb-refresh-token'

/**
 * Cookie（入れ物）の保持期間。アクセストークン(JWT)の有効期限とは別物である点に注意。
 * JWT の失効は Supabase 側（既定 1h）が発行時に埋め込み、サーバー検証時に判定する。
 * Cookie 自体はセッション上限（＝リフレッシュトークン寿命 30日）まで保持し、
 * 期限切れアクセストークンは authMiddleware がリフレッシュで入れ替える。
 * 以前は access Cookie の maxAge を JWT と同じ 3600 にしていたため、
 * 1時間で Cookie ごと消え、リフレッシュに入れず即ログアウトしていた。
 */
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 days

const BASE_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
}

/** アクセス／リフレッシュ両 Cookie を同じ寿命（30日）で発行する。 */
export function setAuthCookies(accessToken: string, refreshToken: string): void {
  setCookie(ACCESS_COOKIE, accessToken, { ...BASE_COOKIE_OPTS, maxAge: SESSION_COOKIE_MAX_AGE })
  setCookie(REFRESH_COOKIE, refreshToken, { ...BASE_COOKIE_OPTS, maxAge: SESSION_COOKIE_MAX_AGE })
}
