import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_SERVICE_ROLE: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  META_APP_SECRET_SSM_KEY: z.string().min(1),
  WEBHOOK_VERIFY_TOKEN_SSM_KEY: z.string().min(1),
  ANTHROPIC_API_KEY_SSM_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | undefined

function parseEnv(): Env {
  if (cached) return cached
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Missing or invalid environment variables: ${missing}`)
  }
  cached = result.data
  return cached
}

// Lazy proxy: env vars are only validated on first property access.
// Keeps SSG prerender working at build time when the host has no runtime secrets,
// while still failing fast on the first request that actually needs them.
export const env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return parseEnv()[prop as keyof Env]
  },
})
