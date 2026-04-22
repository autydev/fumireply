<!-- SPECKIT START -->
Active feature plan: [specs/001-mvp-app-review/plan.md](specs/001-mvp-app-review/plan.md)

Related artifacts (same directory):
- spec.md — feature specification
- research.md — technology decisions
- data-model.md — Drizzle schema design
- contracts/ — external/internal API contracts
- quickstart.md — setup + review submission walkthrough

Read the current plan for technology stack, project structure, and workflow conventions before starting implementation work.
<!-- SPECKIT END -->

<!-- INTENT-SKILLS START -->
# TanStack Intent — Agent Skills (auto-loaded from node_modules)

These skill mappings are maintained via `npx @tanstack/intent@latest install`. When Claude works on a task matching a `task:` keyword below, it should load the corresponding `SKILL.md` from `app/node_modules/` into context before implementing. Run `cd app && npx @tanstack/intent@latest list` to see all available skills and re-run `install` after adding/updating TanStack packages.

skills:
  - task: "TanStack Start project setup, createStart, StartClient, StartServer, React-specific imports, useServerFn"
    load: "app/node_modules/@tanstack/react-start/skills/react-start/SKILL.md"
  - task: "React Server Components in TanStack Start, RSC, renderServerComponent, Composite Components"
    load: "app/node_modules/@tanstack/react-start/skills/react-start/server-components/SKILL.md"
  - task: "TanStack Router core concepts, route trees, createRouter, createRoute, file naming conventions"
    load: "app/node_modules/@tanstack/router-core/skills/router-core/SKILL.md"
  - task: "Route protection, beforeLoad, redirect(), authenticated layouts, RBAC, auth context"
    load: "app/node_modules/@tanstack/router-core/skills/router-core/auth-and-guards/SKILL.md"
  - task: "TanStack Router code splitting, .lazy.tsx, createLazyFileRoute, lazyRouteComponent"
    load: "app/node_modules/@tanstack/router-core/skills/router-core/code-splitting/SKILL.md"
  - task: "TanStack Router data loading, loader, loaderDeps, staleTime, pendingComponent, errorComponent, router context DI"
    load: "app/node_modules/@tanstack/router-core/skills/router-core/data-loading/SKILL.md"
  - task: "TanStack Router navigation, Link, useNavigate, router.navigate, preloading, scroll restoration"
    load: "app/node_modules/@tanstack/router-core/skills/router-core/navigation/SKILL.md"
  - task: "notFound(), notFoundComponent, errorComponent, CatchBoundary, route masking"
    load: "app/node_modules/@tanstack/router-core/skills/router-core/not-found-and-errors/SKILL.md"
  - task: "Dynamic path segments $paramName, splat routes, optional params, useParams"
    load: "app/node_modules/@tanstack/router-core/skills/router-core/path-params/SKILL.md"
  - task: "validateSearch, search param validation with Zod/Valibot, search middlewares, loaderDeps"
    load: "app/node_modules/@tanstack/router-core/skills/router-core/search-params/SKILL.md"
  - task: "TanStack Router SSR, streaming, RouterClient/RouterServer, createRequestHandler, HeadContent/Scripts, head option"
    load: "app/node_modules/@tanstack/router-core/skills/router-core/ssr/SKILL.md"
  - task: "TanStack Router type safety, Register, from narrowing, getRouteApi, LinkProps"
    load: "app/node_modules/@tanstack/router-core/skills/router-core/type-safety/SKILL.md"
  - task: "TanStack Router bundler plugin, route generation, autoCodeSplitting, routesDirectory"
    load: "app/node_modules/@tanstack/router-plugin/skills/router-plugin/SKILL.md"
  - task: "TanStack Start core, tanstackStart() Vite plugin, getRouter, root route document shell, routeTree.gen.ts"
    load: "app/node_modules/@tanstack/start-client-core/skills/start-core/SKILL.md"
  - task: "TanStack Start deployment, Cloudflare/Netlify/Vercel/Node, selective SSR, SPA mode, static prerendering, ISR"
    load: "app/node_modules/@tanstack/start-client-core/skills/start-core/deployment/SKILL.md"
  - task: "TanStack Start execution model, isomorphic-by-default, createServerOnlyFn, createClientOnlyFn, ClientOnly, useHydrated, env var safety"
    load: "app/node_modules/@tanstack/start-client-core/skills/start-core/execution-model/SKILL.md"
  - task: "createMiddleware, request middleware, server function middleware, next({ context }), sendContext, createStart global middleware"
    load: "app/node_modules/@tanstack/start-client-core/skills/start-core/middleware/SKILL.md"
  - task: "createServerFn GET/POST, inputValidator Zod, useServerFn, getRequest/setResponseHeader, throw redirect, FormData, .server.ts file organization"
    load: "app/node_modules/@tanstack/start-client-core/skills/start-core/server-functions/SKILL.md"
  - task: "TanStack Start server routes, server property on createFileRoute, GET/POST/PUT/DELETE handlers, createHandlers, API routes"
    load: "app/node_modules/@tanstack/start-client-core/skills/start-core/server-routes/SKILL.md"
  - task: "TanStack Start server runtime, createStartHandler, getRequest, setCookie/getCookie, useSession, AsyncLocalStorage context"
    load: "app/node_modules/@tanstack/start-server-core/skills/start-server-core/SKILL.md"
  - task: "Virtual file routes, rootRoute, index, route, layout, physical, defineVirtualSubtreeConfig, programmatic route tree"
    load: "app/node_modules/@tanstack/virtual-file-routes/skills/virtual-file-routes/SKILL.md"
<!-- INTENT-SKILLS END -->
