import { createFileRoute } from '@tanstack/react-router'
import { LoginForm } from './-components/LoginForm'

export const Route = createFileRoute('/(auth)/login/')({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo:
      typeof search.returnTo === 'string' && search.returnTo.startsWith('/')
        ? search.returnTo
        : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  component: LoginPage,
})

function LoginPage() {
  const { returnTo } = Route.useSearch()
  return (
    <main>
      <LoginForm returnTo={returnTo} />
    </main>
  )
}
