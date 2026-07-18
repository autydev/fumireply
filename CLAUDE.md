<!-- SPECKIT START -->
Active feature plan: [specs/008-fix-ai-worker-timestamp/plan.md](specs/008-fix-ai-worker-timestamp/plan.md)

Related artifacts (same directory):
- spec.md — feature specification (issue #75: ai-worker が `max(timestamp)` の型不一致 TypeError でクラッシュし、outbound ありの会話で AI 下書き生成/再生成が必ず失敗するバグの修正。P1 根本修正 / P2 pending 放置防止 / P3 timeout 整合 / P4 DLQ 後始末)
- research.md — design decisions (D1 型付きカラム select + orderBy+limit / D2 outer try/catch を ApproximateReceiveCount で分岐、最終受信のみ終端状態を書く / D3 リトライラダー短縮 15s×3+4s=49s < Lambda 60s、terraform 変更なし / D4 DLQ redrive の安全性分析 / D5 回帰テスト戦略)
- data-model.md — DB スキーマ変更ゼロ。ai_drafts 状態遷移に internal_error 経路 3 パターンを追加、不変条件 4 つ
- contracts/draft-failure-handling.md — 境界クエリ BEFORE/AFTER、processDraftJob の receiveCount 契約、リトライラダー定数、構造化ログ (draft_job_unexpected_error)、クライアント互換性
- quickstart.md — env/IAM/SSM/terraform 追加なし。CloudWatch Logs Insights 検証クエリ + DLQ redrive 運用手順

Predecessors:
- [specs/006-message-echoes-ingest/plan.md](specs/006-message-echoes-ingest/plan.md) — Meta `message_echoes` 経由で外部送信を outbound として取り込み。返信済み会話が増え本バグの発生率を押し上げた。
- [specs/005-draft-regenerate-oneoff/plan.md](specs/005-draft-regenerate-oneoff/plan.md) — AI 下書きのワンオフ再生成。失敗時 status='ready'+error の挙動を 008 の internal_error 経路でも踏襲。
- [specs/004-batch-draft-unanswered/plan.md](specs/004-batch-draft-unanswered/plan.md) — 会話スコープのアクティブ下書き 1 件モデル + 未返信バッチ。006 で外部送信が境界に正しく入る。
- [specs/003-customer-context-and-settings/plan.md](specs/003-customer-context-and-settings/plan.md) — 永続 custom_prompt / DraftSettingsEditor / 5 段プロンプト合成。
- [specs/002-app-review-submission/plan.md](specs/002-app-review-submission/plan.md) — Connect Page UI + Paraglide JS i18n。
- [specs/001-mvp-app-review/plan.md](specs/001-mvp-app-review/plan.md) — MVP for the underlying Messenger inbox + AI draft pipeline.

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
