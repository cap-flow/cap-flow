---
date: 2026-06-01
stage: API cost reduction
---

# Снижение расходов DeBank + admin-настраиваемые кнобы (app_settings)

## Контекст

Capflow платит DeBank Pro по объёму запросов. Аудит показал, что DeBank
используется лишь на 4 эндпоинта (`all_history_list`, `all_token_list`,
`all_complex_protocol_list`, `total_balance`), а остальное уже покрыто
гибридом источников (Alchemy, Etherscan, Krystal, DefiLlama, Helius…).
Полностью убрать DeBank нельзя (позиции в ~500 протоколов = его ядро), но
70-90% счёта снимается дёшево: убрать слепой авто-рефреш, не терять историю
на первой загрузке, и дать владельцу тюнинг лимитов из админки.

Требования владельца:
- История: грузить ВСЕ страницы на первой загрузке; потом — только новое
  (2-5 страниц максимум).
- Авто-рефреш: только когда юзер реально в сервисе (вкладка активна, online),
  не чаще 1 раза в час; неактивный/offline → не рефрешить.
- Admin-блок «Расходы и настройки API»: расходы по всем провайдерам +
  редактируемые кнобы с вводом своих значений.

## Решение

### 1. История DeBank — полный бэкфилл + дешёвый инкремент
`fetchAllHistory` теперь возвращает `reachedEnd` (дошли до естественного конца
vs упёрлись в `maxPages`). Call-site в `LoadedWalletsProvider`:
- **первая загрузка** (нет кэша/server-hydration) → большой cap
  (`debank.historyMaxPagesFirstLoad`, дефолт 500), грузим до конца, БЕЗ
  `stopWhen` (иначе он бы стопнулся на первой свежей tx и не дотянул старое);
- **инкремент** (есть полный кэш, `historyComplete === true`) → малый cap
  (`debank.historyMaxPagesIncremental`, дефолт 5) + `stopWhen` на известной tx.

Флаг `historyComplete` хранится в `Loaded`/кэше; server-hydration (канонично
полный `chain_operations` стор) помечается complete, чтобы свежие устройства
не делали дорогой повторный бэкфилл. `CACHE_VERSION 11→12`. Усечение
логируется (no silent caps).

### 2. Авто-рефреш — activity-gating (frontend + backend cron)
**Frontend:** слепой `setInterval(1ч)` заменён на `maybeRefresh()`, гейтящий по
`visibilityState==='visible'` + `navigator.onLine` + троттлу (анкер = самый
свежий `loadedAt` или штамп попытки). Триггеры: `visibilitychange`, `focus`,
`online` + 5-мин будильник. Скрытая вкладка / offline → ничего.

**Backend cron:** серверный `worker.ts` планирует повторяющийся refresh на
каждый активный аккаунт (BullMQ, 1ч). Гейт неактивных стоит в
`PortfolioRefreshProcessor` (на ИСПОЛНЕНИИ задачи, не на bootstrap — иначе
расписание, заданное раз при старте, игнорировало бы изменение активности):
для `trigger==='cron'` смотрим `lastLoginAt` владельца аккаунта; если он не
заходил ≥ N дней — задачу пропускаем (DeBank не зовём), логируем. Ручной
рефреш (admin/user) НЕ гейтится. N = knob `portfolio.refreshSkipInactiveDays`
(дефолт 30, 0 = выкл.), читается live через свой `AppSettingsService` в
воркере (TTL ~10s подхватывает правки из админки через БД). Консервативно:
N=0 / `last_login_at IS NULL` / ошибка lookup'а → рефрешим.
`AccountsRepository.getOwnerLastLoginAt` джойнит accounts→users.

### 3. app_settings — admin-настраиваемые кнобы
Новая таблица `app_settings` (key-value, env-fallback; миграция **0026**,
т.к. 0025 занята параллельной golden/anomaly-веткой). Зеркало
`integration_secrets`, но БЕЗ шифра (значения несекретны).

`AppSettingsService` (`apps/api/src/modules/app-settings/`):
- resolution `DB-override → catalog.default(env)`;
- in-proc кэш TTL ~10s, инвалидация на `set/reset`;
- `getNumber` / `getSnapshotSync` (hot-path) / `listResolved` / `frontendConfig`.

Каталог кнобов (`app-settings.catalog.ts`) — единый источник для UI и резолвера:
rate limits, квоты per-provider, cache TTL, retry, DeBank history maxPages,
авто-рефреш. Поле `hotReload`:
- **live** (rate limits через геттеры в `RateLimitConfig`, квоты в
  `admin-usage.routes`) — применяются без рестарта;
- **restart** (cache TTL, retry — читаются в конструкторах) — UI показывает хинт.

Роуты: admin `GET/PATCH/DELETE /admin/app-settings` + публичный
`GET /me/app-config` (только `scope:'frontend'`). Веб: `useAppConfig()` кормит
`appConfigRef` в `LoadedWalletsProvider` (пагинация + авто-рефреш). UI —
вкладка «Настройки» в `ApiUsagePage` (релейбл → «Расходы и настройки API»)
+ `SettingsPanel` (группы, валидация min/max, source-бейдж, restart-хинт).

Плюс: спам-фильтр в Реестре операций использует `isJunkOp`
(phantom/scam_airdrop) поверх символьных эвристик `looksLikeSpam`.

## Что НЕ делали (и почему)
- Не заменяли `all_complex_protocol_list` (позиции ~500 протоколов) — это
  отдельный продукт уровня DeBank, окупаемость только при ~$2-5k/мес расходов.
- Cache TTL / retry оставлены restart-only — rewire hot-path не оправдан.

## Проверка
- Миграция 0026 применена; api+web typecheck чисты; 905 api + 486 web тестов.
- `AppSettingsService` verified против дев-БД (13/13: set→live→reset, валидация,
  scoping). Эндпоинты зарегистрированы (401/403 vs 404).

## Файлы
- `apps/web/src/lib/debank.ts`, `.../LoadedWalletsProvider.tsx`, `lib/cache.ts`
- `packages/db/src/schema/app_settings.ts`, `drizzle/0026_app_settings.sql`
- `apps/api/src/modules/app-settings/*`, `upstream-proxy/rate-limit.ts`,
  `admin-usage/admin-usage.routes.ts`, `app.ts`
- `apps/web/src/features/{app-config,admin/app-settings}/*`,
  `pages/admin/ApiUsagePage.tsx`, `components/admin/AdminShell.tsx`

## Follow-up
- Мульти-реплика: PATCH применяется на других инстансах в пределах TTL (~10s);
  при необходимости — Redis pub/sub «settings-changed».
- Опционально вынести `total_balance`/`token_list` на Alchemy×DefiLlama
  (Рычаг 1) — ещё ~⅔ рекуррентного DeBank-трафика.
