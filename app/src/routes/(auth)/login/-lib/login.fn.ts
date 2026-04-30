import { createServerFn } from '@tanstack/react-start'
import { performLogin } from './login.server'

export type { LoginResult } from './login.server'

export const loginFn = createServerFn({ method: 'POST' })
  .inputValidator((input: { email: string; password: string }) => input)
  .handler(({ data }) => performLogin(data))
