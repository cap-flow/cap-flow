---
date: 2026-05-11
stage: SaaS Frontend (branch A)
---

# SaaS Frontend — branch A: web UI поверх Phase 0–8 backend

## Контекст

После закрытия backend каркаса (Phase 0–8) фронтенд для администратора и
пользователя был частично готов из предыдущих итераций: AuthProvider с
single-flight refresh, AdminShell + 8 admin страниц, ProtectedRoute,
ImpersonationBanner, i18n (ru+en), React Query, Tailwind UI-кит.

В этой ветке закрывался **user-side** + **админский biling/flags**.
Остальные подэтапы (Phase 7b notifications wire-up, реальные blockchain
providers) — отдельно.

## Решение

### Шесть шагов, итерациями по одному pull-up без перерывов

**Step 1 — recon + smoke**. Запустил vite dev + проверил что
`/api/v1/auth/login` через proxy возвращает 200 + Set-Cookie `cap_refresh`.
Подтвердил что текущий AuthProvider живой.

**Step 2 — public страницы**:
- `/invite/:token` — preview через GET, форма регистрации (email read-only,
  только password + name), auto-login через accessToken + AuthProvider.refresh().
- `/reset-password` — запрос (always 204, no-enumeration UX).
- `/reset-password/:token` — установка нового пароля → редирект в
  `/login`.

**Step 3 — user billing** (`/billing`):
- Status card с цветовым индикатором (beta/active/grace/expired).
- Allocate USDT адреса (TRC20/ERC20), idempotent — second click возвращает
  тот же address. Кнопка «копировать».
- История платежей.

**Step 4 — user prefs** (`/preferences`):
- Telegram: get/start/unlink. Show `code` + `deepLink`; пока бот не
  настроен — UI говорит юзеру сохранить код для ручной активации.
- Subscriptions: матрица событие × канал (email/telegram). Список типов
  захардкожен в `KNOWN_NOTIFICATION_TYPES` (sync с тем что worker реально
  emits). Default = enabled (соответствует backend semantics).

**Step 5 — admin билинг + флаги**:
- `/admin/billing` — split layout: список юзеров слева, panel справа с
  status + manual credit + история с inline Refund.
- `/admin/feature-flags` — таблица groupBy(key), inline-toggle enabled,
  inline-delete, форма create/upsert с выбором scope (global/account/user)
  + scopeRefId для не-global.

### API client расширения

- Добавил `api.put<T,B>(...)` (backend feature-flags + notifications
  используют PUT).
- Сохранил existing single-flight `tryRefresh` — все новые `useQuery`
  автоматически попадают под auto-retry on 401.

### Маршрутизация

App.tsx разрастился до 13 маршрутов:
- Публичные: `/login`, `/invite/:token`, `/reset-password[/:token]`.
- User: `/`, `/performance`, `/closed`, `/registry`, `/wallet/*`,
  `/users`, `/billing`, `/preferences`, `/settings`.
- Admin: `/admin/{metrics,portfolios,users,invites,audit,tech-audit,queue,api-usage,billing,feature-flags}`.

## Альтернативы

- **Отдельная страница admin для каждого юзера** vs split-view —
  выбрал split (master/detail) потому что admin часто переключается
  между юзерами; deep-link маршрут с `:userId` можно добавить
  тривиально, если потребуется.
- **Inline-toggle для подписок** vs форма-таблица — inline быстрее для
  юзера и проще в реализации (один useMutation на upsert).
- **Custom Switch UI компонент** vs `<input type="checkbox">` — взял
  native checkbox в admin/feature-flags + preferences. Когда добавим
  shadcn Switch, mass-rename через codemod.
- **WebSocket для status updates** (billing/queue) — отложил. React Query
  cache + 30s staleTime для билинга и manual refetch для queue достаточны.

## Реализация

### Новые модули фронта

```
src/features/billing/                          # user-side
  api.ts        BillingSummary, PaymentAddress, payments
  hooks.ts      useBillingSummary, useAllocateAddress, usePaymentsHistory

src/features/telegram/
  api.ts        status/start/unlink
  hooks.ts      useTelegramStatus, useStartTelegramLink, useUnlinkTelegram

src/features/notifications/
  api.ts        KNOWN_NOTIFICATION_TYPES + list/upsert
  hooks.ts      useNotificationSubscriptions, useUpsertSubscription

src/features/invites/api.ts                    # public preview + register
src/features/password-reset/api.ts             # public request + confirm

src/features/admin/billing/                    # admin-side
  api.ts, hooks.ts

src/features/admin/feature-flags/
  api.ts, hooks.ts
```

### Новые pages

```
src/pages/InvitePage.tsx
src/pages/PasswordResetPage.tsx                # request + confirm
src/pages/BillingPage.tsx
src/pages/PreferencesPage.tsx
src/pages/admin/BillingPage.tsx                # split master/detail
src/pages/admin/FeatureFlagsPage.tsx
```

### Маленькие правки в существующих

- `lib/api/client.ts` — добавлен `api.put<T,B>`.
- `App.tsx` — 6 новых маршрутов.

## E2E (HTML + API через vite proxy, 14/14)

| Что | Результат |
|---|---|
| `/`, `/login` | 200 |
| `/invite/abcdef`, `/reset-password[/xyz]` | 200 (SPA отдаёт HTML) |
| `/billing`, `/preferences` | 200 |
| `/admin/billing`, `/admin/feature-flags` | 200 |
| `GET /api/v1/me/billing` | 200 + JSON status=active, daysLeft=365 |
| `GET /api/v1/me/telegram` | 200 |
| `GET /api/v1/me/notifications` | 200 |
| `GET /api/v1/admin/feature-flags` | 200 |
| `GET /api/v1/admin/users/:id/billing` | 200 + subscription + history |
| `PUT /admin/feature-flags/canary_v2` | upsert OK |
| `PUT /me/notifications` (Alice) | upsert OK |
| `POST /me/billing/payment-address` (Alice) | возвращает existing TRC20 address |
| `POST /me/telegram/start` (Alice) | code + (empty) deepLink |

Auto-refresh на 401 проверен через AuthProvider boot path: на свежий
браузерный hard-reload без access token первый запрос /auth/me возвращает
401, single-flight refresh берёт новый из cookie, retry /auth/me возвращает
200 — это происходит на каждом запуске UI.

## Ограничения

- **Sidebar/AppShell ссылок на `/billing`, `/preferences` нет** — страницы
  доступны только через прямой URL. UI-навигация добавится одной правкой
  в `AppShell` когда дойдёт до polish-этапа.
- **Admin sidebar** не имеет ссылок на новые `/admin/billing` и
  `/admin/feature-flags` — аналогично, правка в `AdminShell`.
- **Notifications-strings локализованы вручную в коде** (русские строки
  в `KNOWN_NOTIFICATION_TYPES`). При расширении i18n переносим в `i18n/`.
- **HTML-форматирование email-писем** не делаем — text-only. UI/UX-улучшение
  параллельно с подключением Resend.
- **Bull-board uses HTML page, открывается напрямую** — он зарегистрирован
  на backend под `/api/v1/admin/queue/ui`. Frontend сейчас на это не
  ссылается; администратор открывает URL напрямую.
- **react-query QueryClientProvider** должен быть на корневом уровне —
  предполагается, что он есть (стандартный setup). Если нет — `useQuery`
  упадёт; добавляется одной правкой в `main.tsx`.
- **Невыделение dev-vs-prod build mode** — `import.meta.env.VITE_API_URL`
  поддерживается; в prod build → точный API host вместо `/api` proxy.
