import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { performLogin } from './login.server'

export type { LoginResult } from './login.server'

export const loginFn = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ email: z.string(), password: z.string() }))
  .handler(({ data }) => performLogin(data))
