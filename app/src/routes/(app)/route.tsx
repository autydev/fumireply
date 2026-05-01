import { createFileRoute, Outlet } from '@tanstack/react-router'
import { TokenStatusBanner } from './-components/TokenStatusBanner'

export const Route = createFileRoute('/(app)')({
  component: AppLayout,
})

function AppLayout() {
  return (
    <>
      <TokenStatusBanner />
      <Outlet />
    </>
  )
}
