---
date: 2026-05-11
stage: SaaS Phase 6
---

# SaaS Phase 6 — feature flags, canary rollout, версионирование методики

## Контекст

Phase 5 закрыл админский слой. Phase 6 — **то, как мы будем безопасно
выкатывать изменения** в boot-stable SaaS:

- новые версии алгоритмов (cost basis, V3 IL, identification) включаются
  поэтапно (admin → 5 бета-юзеров → all) — см. `saas-analytics-layers`
- временные kill-switch фичи (отключить refresh при инциденте upstream)
- per-user / per-account beta-доступ (например, новый дашборд только
  для Alice пока всё устаканится)

Таблица `feature_flags` уже была заложена в Phase 0 (per-scope: global /
account / user). Phase 6 поверх неё построил CRUD + резолвер с
precedence + Redis-cache + helper для использования в любом сервисе.

## Решение

**Precedence**: для (key, user, account):

```
   1. user-scope row (если userId дан)        ← override per-user
   2. account-scope row (если accountId дан)  ← override per-account
   3. global row                              ← default включения
   4. default → false                         ← floor (нет рядов)
```

User-override **сильнее** глобального и в обе стороны: можно дать кому-то
доступ к фиче, которая выключена глобально (бета), **и** можно явно
отключить юзеру фичу, которая включена глобально (если у него баг).

**Cache** — Redis ключ `flag:{key}:u={userId|-}:a={accountId|-}`, TTL 30
сек. На каждый upsert/delete делаем wildcard `SCAN` по `flag:{key}:*` и
`DEL` всех найденных шардов — мгновенная синхронная инвалидация поверх.

**Helpers** — `flags.enabled(key, ctx)` для условных веток в коде:

```ts
if (await flags.enabled("cost_basis_v2", { userId: req.user.id })) {
  // new path
} else {
  // legacy
}
```

`resolveAll([…], ctx)` — для seed-а флагов на фронте за один запрос.

**Default = false floor** — выбор намеренный. Новый флаг без рядов
автоматически OFF для всех; admin создаёт `global enabled=false` чтобы
официально «зарегистрировать» флаг, потом `user enabled=true` для бета-
кохорты, потом перевод `global` в `true`. Это идеально ложится на
канареечный workflow:

```
коммит → admin создаёт flag:enabled=false global → ты обкатываешь у себя
через user-override → расширяешь на 5 бета-юзеров (5 user-overrides) →
flip global=true → удаляешь user-overrides (теперь все на global)
```

## Альтернативы

- **Percentage-based rollout** (`enabled to 25% of users`) — отложили.
  Удобно при 1000+ юзерах. На beta с 25 пользователями explicit
  per-user overrides проще и нагляднее.
- **Stale-while-revalidate** в кэше — отложили. TTL 30 сек + явная
  invalidation на upsert закрывают практический use-case.
- **In-process LRU cache** вместо Redis — отвергли: при 2+ инстансах API
  не разделяется, теряется на reload.
- **Unique constraint** на `(key, scope, scope_ref_id)` в БД —
  отложил. `FeatureFlagsRepository.upsert` эмулирует через select-then-
  update; для текущей нагрузки достаточно. Constraint добавится отдельной
  миграцией когда зафиксируем схему.
- **bull-board-style UI для флагов** (визуальный toggle) — frontend
  задача; backend API готов.

## Реализация

`apps/api/src/modules/feature-flags/`:

- `feature-flags.repository.ts`
  - `listAll`, `listByKey` — для админского viewer-а.
  - `fetchForResolution({key, userId, accountId})` — одна query, возвращает
    максимум 3 ряда (global + per-user + per-account). **Внимание**:
    composability `or()` из drizzle вместо `sql.join` (ниже почему).
  - `upsert({key, scope, scopeRefId, enabled, payload})` — find-or-update;
    по факту guard за future unique constraint.
  - `delete(id)`.
- `feature-flags.service.ts`
  - `resolve(key, ctx)` — cache → fetchForResolution → applyPrecedence.
  - `enabled(key, ctx)`, `resolveAll(keys, ctx)`.
  - `upsert(input, actorAdminId)` — валидирует scope+scopeRefId match,
    invalidate, audit.
  - `deleteById(id, actorAdminId)` — same.
  - `invalidate(key)` — SCAN `flag:{key}:*` + DEL.
- `feature-flags.routes.admin.ts` — `requireAdmin`:
  - `GET /admin/feature-flags` — все ряды.
  - `GET /admin/feature-flags/:key` — все scope-ряды для одного key.
  - `PUT /admin/feature-flags/:key` — upsert (body содержит scope,
    scopeRefId, enabled, payload).
  - `DELETE /admin/feature-flags/:id` — drop по id.
- `feature-flags.routes.public.ts` — `requireAuth`:
  - `GET /api/v1/me/feature-flags?keys=a,b,c&accountId=…` — bulk resolve
    для seed-а фронтенда. Cap 50 keys.

### SQL bug найден и пофикшен

Первый draft `fetchForResolution` лепил OR через
`sql.join(branches, 'OR')`, где каждая branch была `and(...)` из
drizzle. На рантайме генерировалось `WHERE key = $1 AND ()` — без
содержимого OR-блока — что эквивалентно `WHERE key = $1`, и каждый
вызов возвращал **все** ряды флага. `applyPrecedence` находил user-row
для другого вопроса и зачем-то source="user" получал unknown-key.

Фикс: заменил на типизированный `or(...branches)`. Один тест-кейс
(шаг 15 в E2E) поймал это: запрос `keys=cost_basis_v2,unknown_a,unknown_b`
возвращал `source:"user"` для всех трёх. После фикса → `source:"default"`
для unknown. Это и было ценностью отдельного E2E-прогона.

## E2E (18/18 пройдено, включая регрессию)

| # | Сценарий | Результат |
|---|---|---|
| 1 | unknown flag → default(false) | ✓ |
| 2 | Создать global `cost_basis_v2=false` | ✓ |
| 3 | Alice → source=global, enabled=false | ✓ |
| 4 | Создать user-override для Alice = true | ✓ |
| 5 | Alice → source=user, enabled=true | ✓ |
| 6 | Bob → source=global, enabled=false | ✓ |
| 7 | Flip global → true | ✓ |
| 8 | Bob → global=true (без override) | ✓ |
| 9 | Alice → user-override wins (`source:"user"`) | ✓ |
| 10 | Alice override → false (negative override) | ✓ |
| 11 | Alice → enabled=false (user override > global=true) | ✓ |
| 12 | Admin GET /:key → оба ряда | ✓ |
| 13 | Alice → /admin/feature-flags = 403 | ✓ |
| 14 | Redis cache keys видны | ✓ |
| 15 | Multi-key resolveAll (regression) | ✓ после fix |
| 16 | Validation: scope=user + scopeRefId=null → 400 | ✓ |
| 17 | DELETE Alice override → global takes over | ✓ |
| 18 | audit_log: 5 events (`feature_flag.upserted/deleted`) | ✓ |

## Ограничения

- **Нет percentage rollouts**. При 25 юзерах прицельный выбор
  per-user работает; при 200+ потребуется. Расширение
  `targeting_rule` jsonb уже есть в схеме — Phase 6 не использует.
- **Cache не разделён между instances API** — все ходят в общую Redis,
  это норм. При worker-инстансе он тоже видит общий кэш — мутация в
  API инвалидирует и для worker-а.
- **Wildcard SCAN** при инвалидации — `O(n)` по ключам Redis. При
  thousand keys / second не проблема (Redis SCAN с COUNT=100), но
  бенчмарк не делал.
- **Нет UI** — фронтенд админ-панели подключится к
  `/admin/feature-flags` endpoint-ам, как и к остальным Phase 5 модулям.
- **`payload` jsonb не валидируется по схеме** — фича-зависимая
  структура (например, `{maxAccounts: 3}` для лимитного флага); caller
  ответственен за её shape.
- **Один уровень scope** — нельзя «глобально+аккаунт+юзер всё сразу»
  как additive override stack. Хватает на текущий рост; advanced rule-
  engine — отдельный проект.
- **Audit без diff** — `payload` записывает только новое значение, не
  «было/стало». Можно дотянуть, если будет нужно.
