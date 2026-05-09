import { createFileRoute } from '@tanstack/react-router'
import { LoginForm } from './-components/LoginForm'
import { LanguageToggle } from '~/routes/(app)/-components/LanguageToggle'

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
    <div style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 10 }}>
        <LanguageToggle />
      </div>
      <LoginForm returnTo={returnTo} />
    </div>
  )
}
