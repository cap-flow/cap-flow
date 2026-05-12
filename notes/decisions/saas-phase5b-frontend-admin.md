---
date: 2026-05-11
stage: SaaS Phase 5b
---

# SaaS Phase 5b — admin-панель на фронте

## Контекст

После Phase 5 backend выставлял 7 admin-only модулей под `/api/v1/admin/*`,
но никакого UI на них не было. `apps/web` оставался legacy single-user
дашбордом Capflow: API-клиент не цеплял Bearer-токен, не знал про refresh
cookie, а сэмпл `UsersPage` ходил в удалённый `/v1/users` endpoint.
Чтобы открыть SaaS-бету, нужен был фронт с авторизацией, защитой роутов,
шеллом для админских разделов и страницами на каждый существующий endpoint.

## Решение

**Пять подэтапов, последовательно** — каждый смоук-тестился в браузере
прежде чем переходить дальше:

### 5b.1 — Auth foundation

- **`lib/auth/token-store.ts`** — in-memory access-token + subscribe.
  Намеренно не персистится — refresh-cookie httpOnly, на reload новый
  access мнётся через `/auth/refresh`.
- **`lib/api/client.ts`** — `credentials: 'include'`, инжект Bearer,
  **single-flight 401 → /refresh → retry**, hook `onUnauthorized` для
  AuthProvider. `Content-Type: application/json` ставится только когда
  есть body (иначе Fastify 400 на пустой /logout).
- **`features/auth/AuthProvider.tsx`** — context с `user/isAdmin/login/
  logout/refresh/startImpersonation/endImpersonation`. На mount пробует
  `/auth/me`, через interceptor авто-restore через refresh-cookie.
- **`pages/LoginPage.tsx`** + **`components/auth/ProtectedRoute.tsx`** —
  `ProtectedRoute` гейтит на залогиненность, `AdminRoute` — на admin
  role. Boot-splash чтобы не флэшить login для уже-залогиненных.
- **Backend touch:** `meResponseSchema` расширен `impersonation:
  {impersonatorId, mode} | null`, `/auth/me` теперь возвращает
  impersonation context из `req.user.impersonation`. Login/refresh
  всегда отдают `impersonation: null` (refresh-rotation создаёт новую
  не-импернесованную сессию).

### 5b.2 — Admin shell + 8 заглушек

- **`components/admin/AdminShell.tsx`** — отдельный layout: 64-px
  sidebar с ADMIN-бэйджем, 8 nav-пунктами, ссылкой «В пользовательский
  режим»; topbar с email + Выйти. **Не разделяет state с legacy
  AppShell** — никаких `SidebarProvider`/`LoadedWalletsProvider`.
- **8 stub-страниц** в `pages/admin/`: Metrics, Portfolios, Users,
  Invites, Audit, TechAudit, Queue, ApiUsage. Общий
  `_PageHeader.tsx` с `PageHeader` + `ComingSoon`.
- **`App.tsx` расщеплён** на `AdminRoutes` (под `AdminRoute → AdminShell`)
  и `UserRoutes` (под `ProtectedRoute → AppShell`). `/admin` → `/admin/metrics`.
- В legacy `AppShell` добавлен пункт «Admin» (Shield icon), виден только
  для `isAdmin`.

### 5b.3 — Users page + impersonation

- **`features/admin/users/{api,hooks}.ts`** — `list/setStatus/setRole/
  impersonate` через TanStack Query.
- **`pages/admin/UsersPage.tsx`** — фильтр-bar (status/role select +
  debounced 250ms search), таблица из 7 колонок, per-row `<select>`-ы
  для role/status (отключены для текущего юзера), Impersonate в
  подтверждающем Dialog.
- **`components/auth/ImpersonationBanner.tsx`** — sticky-top красный
  alert когда `user.impersonation` set: «Вы вошли как X · view-mode
  от admin Y», кнопка «Завершить» = logout + /login.
- **Backend touch:** в `admin-users.service.listUsers` коррелированные
  subqueries использовали `${schema.users.id}` который Drizzle печатает
  как `"id"` (без квалификатора) → ambiguous-error в подзапросах с
  `JOIN accounts a`. Зашили `users.id` raw-SQL'ем. Также нормализован
  `lastSnapshotAt` к Date (Postgres возвращает строку для raw subquery).

### 5b.4 — Portfolios + Metrics

- **`features/admin/portfolios/{api,hooks}.ts`** + **`PortfoliosPage`** —
  5 KPI карточек (юзеры/аккаунты/TVL/snapshots-24ч/ошибки-24ч с
  алерт-тоном при ошибках > 0) + таблица 7 колонок (uuid8 prefix
  под именем, primary badge, relative-time last refresh, trigger badge
  cron/manual/stub).
- **`features/admin/metrics/{api,hooks}.ts`** + **`MetricsPage`** —
  5 секций: Users (active/pending/blocked с цветом), Activity (DAU/
  WAU/MAU + подсказки), New users, Invite-воронка, Активация (big-tile
  Invites <24ч и Refresh <7д с tone по порогам ≥80%/40%/10%/<10%).
  Блок «Как читать» добавляет warning при `firstRefreshWithin7dPct=0`
  с указанием на stub-refresh.

### 5b.5 — Audit / TechAudit / Queue / ApiUsage / Invites

- **`/admin/audit`** — окна 1ч/24ч/7д/30д + `as_admin` фильтр + action
  prefix-search + limit 50/100/250/500. Side-panel action-counts с
  кликом-в-фильтр.
- **`/admin/tech-audit`** — findings, сгруппированные по category;
  border-color по worst-severity (error/warning/info); summary
  chip-ы.
- **`/admin/queue`** — 5 count-tiles (Active/Waiting/Delayed/Completed/
  Failed с алерт-цветом на Failed), таблица recurring schedulers с
  `every` и `next` форматирующими; кнопка-ссылка на bull-board UI;
  auto-refetch 5с.
- **`/admin/api-usage`** — окно 1ч/24ч/7д/30д; таблица per-provider
  (calls/cache-hits-with-%/errors/cost-usd); левая панель Top-10
  юзеров (клик → справа квоты юзера с прогресс-барами зелёный/
  жёлтый/красный); таблица последних 50 вызовов (cache vs live
  badge, http status красный при ≥400).
- **`/admin/invites`** — tabs (Все/Pending/Consumed/Revoked/Expired),
  таблица 6 колонок, диалог Create (email/TTL/notes) → **Created**-
  диалог показывает invite-URL ОДИН раз с copy-to-clipboard. Per-row
  «Отозвать» только для pending. **Fix:** `api.delete()` теперь
  опционально принимает schema (раньше падал на DELETE с JSON-телом).

## Альтернативы

- **Отдельный `apps/admin-web` Vite-проект.** Отвергли — два сборки,
  два деплоя, дублирование api-client и token-store. Под одним web,
  `AppShell` vs `AdminShell` через top-level routing — чище.
- **Persist access token в localStorage**, чтобы избегать `/auth/refresh`
  на каждый reload. Отвергли — XSS-вектор. In-memory с auto-refresh
  через httpOnly cookie — единственный приемлемый вариант для SaaS с
  чувствительными данными.
- **Optimistic update на role/status mutations.** Отвергли пока — после
  successful mutation TanStack Query инвалидирует список и refetch'ит.
  Пользователь видит реальное состояние; latency на mutation < 100ms.
- **Не выносить Impersonation banner на App-level, повесить только в
  AppShell.** Корректно для текущего design (AdminRoute редиректит
  не-admin в "/" так что impersonated админ всегда в AppShell), но
  на App-level безопаснее — если позже добавится /me-only route,
  banner всё равно отрисуется.
- **Custom dropdown component для role/status.** Использовал нативный
  `<select>` со стилизованной обёрткой — минимум зависимостей, accessible
  out-of-box, достаточно красиво при существующей теме.

## Реализация

### Структура

```
apps/web/src/
├── components/
│   ├── admin/AdminShell.tsx
│   └── auth/{ImpersonationBanner,ProtectedRoute}.tsx
├── features/
│   ├── admin/
│   │   ├── api-usage/{api,hooks}.ts
│   │   ├── audit/{api,hooks}.ts
│   │   ├── invites/{api,hooks}.ts
│   │   ├── metrics/{api,hooks}.ts
│   │   ├── portfolios/{api,hooks}.ts
│   │   ├── queue/{api,hooks}.ts
│   │   ├── tech-audit/{api,hooks}.ts
│   │   └── users/{api,hooks}.ts
│   └── auth/{api,AuthProvider}.tsx
├── lib/
│   ├── api/client.ts            ← Bearer + 401-refresh interceptor
│   └── auth/token-store.ts
└── pages/
    ├── LoginPage.tsx
    └── admin/
        ├── _PageHeader.tsx
        └── {Metrics,Portfolios,Users,Invites,Audit,TechAudit,Queue,ApiUsage}Page.tsx
```

### Backend touch

- `apps/api/src/modules/auth/auth.schema.ts` — `impersonationInfoSchema`
- `apps/api/src/modules/auth/auth.routes.ts` — `toMe(u, impersonation)`
- `apps/api/src/modules/admin-users/admin-users.service.ts` —
  qualified `users.id`, normalized `lastSnapshotAt`
- `apps/api/src/modules/invites/invites.routes.public.ts` — register
  response теперь включает `impersonation: null`

### Smoke-test покрытие

Каждая страница проверена в браузере через Claude Preview:

| Page | Что проверено |
|---|---|
| /admin/metrics | 5 секций отрендерены: 4/4/0/0 users, DAU=WAU=MAU=3, активация 67%/75% |
| /admin/portfolios | 5 KPI tiles (4/4/$0/26/0), 4 строки таблицы с primary badge |
| /admin/users | 4 строки, role-фильтр → 2 строки, role mutation round-trip, impersonate → red banner → end → /login |
| /admin/audit | 90 строк за 24ч, 5 action-counts (auth.login=39 и т.д.) |
| /admin/tech-audit | 1 category «admin-not-verified», 2 finding-а |
| /admin/queue | 5 tiles 0/0/4/26/0, 5 recurring schedulers, bull-board link |
| /admin/api-usage | 6 provider rows, 2 top-users, recent calls table |
| /admin/invites | Create `phase5b-smoke@example.com` → URL получен → Revoke → status=revoked |

## Ограничения

- **Refresh cookie перезаписывается при impersonate.** После «Завершить»
  кнопка делает logout и редирект на /login — admin должен ввести
  пароль заново. Backend дизайн Phase 2 заложил это; альтернативный
  flow «admin keeps original session + ephemeral impersonation token»
  потребовал бы убрать `setRefreshCookie` в `POST /admin/users/:id/
  impersonate` (Phase 6 или позже).
- **Edit-mode impersonation gate отсутствует.** Сейчас admin в view-mode
  технически имеет тот же доступ что target user (JWT.role = "user").
  Audit log это фиксирует, но write-эндпоинты не блокируют. Решение
  отложено до Phase 6/7.
- **Recent API calls** не показывают полный payload — только status/
  duration/cache. Если нужно дебажить конкретный upstream-вызов —
  смотреть в server logs.
- **Action filter** в Audit ищет по prefix, не fuzzy. Достаточно для
  основного use-case «показать всё про auth/admin/portfolio».
- **Queue auto-refresh 5s** — небольшая нагрузка на admin DB-pool при
  открытой вкладке. При росте — переключить на SSE/WS.
- **Mobile UX** — sidebar `hidden lg:flex`, на узких экранах нет
  drawer (как в legacy AppShell). Админ пользуется десктопом, ok пока.
- **Persisted state в URL** — фильтры/таб/окна не пишутся в URL,
  на reload сбрасываются. При сильном использовании — добавить
  search params.
