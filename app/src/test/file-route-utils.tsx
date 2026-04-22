import type { ReactNode } from 'react'
import { render, type RenderResult } from '@testing-library/react'
import {
  createMemoryHistory,
  createRouter,
  createRootRoute,
  createRoute,
  RouterProvider,
  Outlet,
  type AnyRoute,
} from '@tanstack/react-router'

/**
 * Render a route component in a minimal in-memory router for unit testing.
 *
 * Per TanStack official "Test Router with File-Based Routing" guide, route
 * tests live under `src/test/routes/**` mirroring the routes tree; they do
 * NOT import the generated `routeTree.gen.ts` but build a minimal tree that
 * renders just the component under test.
 */
export function renderRoute({
  path,
  component,
  initialEntries = ['/'],
}: {
  path: string
  component: () => ReactNode
  initialEntries?: Array<string>
}): RenderResult {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  })

  const leafRoute = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component,
  })

  const routeTree = rootRoute.addChildren([leafRoute]) as AnyRoute

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries }),
  })

  return render(<RouterProvider router={router} />)
}
