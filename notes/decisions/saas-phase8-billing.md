---
date: 2026-05-11
stage: SaaS Phase 8
---

# SaaS Phase 8 — crypto subscription billing (USDT TRC20 / ERC20)

## Контекст

Phases 0–7 закрыли auth, multi-tenancy, providers/cache, scheduled refresh,
admin-панель, feature flags и notifications. Phase 8 — **финальный кусок
бета → платная подписка**: тарифы, приёмочные адреса, ledger в
`user_payments`, авто-кредитование по входящим TX и grace-блок при истечении.

Из исходного ТЗ владельца:
- Приём только в **крипте (USDT TRC20 + ERC20)** на старте.
- Тарифы 3 / 6 / 12 мес (цены в env, на старте $100 / $180 / $300).
- Grace-период 3 дня после истечения → read-only.
- Auto-rollover: оплата поверх активного периода продлевает с current
  `period_end`, не с now (юзер не теряет дни).

## Решение

### Ledger — поверх существующего `user_payments`

Phase 0 уже втащил таблицу `user_payments` (`kind`, `plan`, `amount_usd`,
`horizon_months`, `paid_at`, `period_end`, `refunded_payment_id`).
Phase 8 пишет туда:
- `kind: "subscription"` для credit'а (manual или auto)
- `kind: "refund"` с negative amount + `refunded_payment_id` FK

`plan` маппится на существующий `payment_plan` enum:
- 3 мес → `quarterly`
- 6 мес → `semiannual`
- 12 мес → `yearly`

«Активная подписка» = последняя `subscription`-row с `period_end > now()`.
Сервис вычисляет статус из `period_end` ± grace.

### Receive-адреса — pool из env

`BILLING_ADDRESS_POOL_TRC20` / `BILLING_ADDRESS_POOL_ERC20` —
comma-separated. На первый POST `/me/billing/payment-address?network=...`
сервис берёт первый свободный из пула и пишет в
`crypto_payment_addresses (user_id, network, address)` с unique индексом
по `(network, address)`. **Один user — один адрес на network** (повторный
вызов возвращает уже выделенный — idempotent).

HD-wallet rotation — Phase 8b. На beta пул нескольких заранее
сгенерированных адресов на каждую сеть достаточен (5–10 адресов на
network, докинуть в env когда исчерпается).

### Auto-credit pipeline

```
BullMQ recurring "payment-monitor" (every 5 min) → PaymentMonitorService.scan()
  → for each active address: provider.fetchIncoming()
  → upsert into payment_transactions  (idempotent на (network, tx_hash))
  → for each not-credited row with confirmations >= threshold:
       - selectPlanForAmount(amount, plans)  → plan|null
       - if plan: insert user_payments (auto-credit)
                  + link payment_transactions.credited_payment_id
                  + audit "billing.credited_auto"
```

`IBlockchainProvider` интерфейс — `MockBlockchainProvider` всегда возвращает
`[]`. Реальные `TronscanClient` / `EtherscanUsdtClient` — skeletons,
включаются когда зайдут платные API-ключи (Phase 8b). До тех пор pipeline
**работает целиком** на холостых данных — admin-credit покрывает все
сценарии beta.

### Confirmations threshold

`BILLING_MIN_CONFIRMATIONS_TRC20=20`, `BILLING_MIN_CONFIRMATIONS_ERC20=12`
— примерно «достаточно», чтобы reorg-risk был пренебрежимо мал. Tronscan
возвращает `confirmed: true|false` — для confirmed маппим в большое число
(монитор сравнивает с порогом).

### Rollover (stack on top)

При credit-е, если current period_end > now → новый period_end = current +
months. Если истёк → +months от now. Юзер не теряет оплаченные дни.
E2E подтвердил: $100 + $300 → 90d + 360d ≈ 450 days left.

### Grace + блок refresh

`SubscriptionStatus`: `beta | active | grace | expired`.

`grace_until = period_end + 3 days`. Между `period_end` и `grace_until` →
`grace` (юзер видит dashboard, manual refresh ещё работает). После
`grace_until` → `expired`: `POST /accounts/:id/refresh` для не-admin
возвращает 403 «top up».

Cron refresh для expired аккаунтов **продолжает** (нам нужны snapshots
для admin dashboard платформы). Тратится платформенная квота, но это
trade-off в пользу непрерывности данных.

Admins не блокируются — они платят implicitly (платформа их).

### Refund

Любой `subscription`-row можно зарефандить через
`POST /admin/users/:id/billing/refund`. Записывается отдельный
`kind: "refund"`-row с `amount_usd = -original`. Не модифицирует
`period_end` — admin сам решает, отозвать ли подписку (через
дополнительный `setStatus` или second refund перекрывающий период).

## Альтернативы

- **Stripe / Paddle** — отвергли по требованию владельца. Крипто-приём
  не требует customer-side KYC + работает globally.
- **HD wallet rotation** (новый адрес на каждый payment) — отложили в
  Phase 8b. Static pool — proven pattern для beta size.
- **Memo-based attribution** (один master address + memo на платёж) —
  USDT TRC20 не поддерживает memo надёжно. Per-user address — единственный
  reliable способ attribution.
- **Расчёт period_end в SQL trigger** — отвергли: бизнес-логика в коде,
  легче отдебажить.
- **Auto-block через DB trigger** — отвергли по той же причине; check в
  route-handler.
- **Sliding period (`period_end = now + months` на каждый credit)** —
  отвергли: юзер теряет дни если платит до истечения. Stacking честнее.

## Реализация

### Schema (Phase 8 migration)
- `packages/db/src/schema/crypto_payment_addresses.ts`
- `packages/db/src/schema/payment_transactions.ts`
- `packages/db/drizzle/0004_phase8_billing.sql` — applied

### Модули (`apps/api/src/modules/billing/`)
- `pricing.ts` — plan defs + `selectPlanForAmount` resolver.
- `billing.repository.ts` — addresses, payments ledger, observed txs.
- `billing.service.ts` — getSubscription, getOrAllocateAddress,
  creditManual, refundForUser, getHistory.
- `blockchain-providers.ts` — `IBlockchainProvider`, MockProvider,
  TronscanClient + EtherscanUsdtClient skeletons.
- `payment-monitor.service.ts` — scan() + creditReady().
- `billing.routes.ts` — `/me/billing`, `/me/billing/payment-address`,
  `/me/billing/payments`.
- `billing.routes.admin.ts` — `/admin/users/:id/billing` (status+history),
  `/admin/users/:id/billing/credit`, `/admin/users/:id/billing/refund`.

### Queue (`apps/api/src/modules/queue/`)
- `payment-monitor.queue.ts` — отдельная queue + scheduler (every 5 min).

### Worker (`apps/api/src/worker.ts`)
- Подписан на обе queue: `portfolio-refresh` + `payment-monitor`.
- Bootstrap upsert-ит recurring scheduler `payment-monitor` (idempotent).

### Grace middleware
- `portfolio.routes.ts` — для non-admin POST `/accounts/:id/refresh`:
  `billing.getSubscription(account.ownerId)` → `expired` ⇒ 403.

### Env (новое)
- `BILLING_PRICE_3M_USD/6M/12M`
- `BILLING_GRACE_DAYS`
- `BILLING_MIN_CONFIRMATIONS_TRC20/ERC20`
- `BILLING_ADDRESS_POOL_TRC20/ERC20`
- `TRONSCAN_API_KEY` (optional)

## E2E (16/16 пройдено)

| # | Сценарий | Результат |
|---|---|---|
| 1 | Alice fresh `/me/billing` | `status:"beta"` |
| 2 | Allocate TRC20 address | первый из пула, idempotent ID |
| 3 | Repeat allocate | тот же address (idempotent) |
| 4 | Allocate ERC20 | первый из пула |
| 5 | History empty | `[]` |
| 6 | Admin credit $100 | `plan:"quarterly", horizonMonths:3, periodEnd:+3mo` |
| 7 | `/me/billing` after credit | `status:"active", daysLeft:90` |
| 8 | Admin credit $300 stacks | `plan:"yearly", periodEnd:+12mo от prev end` |
| 9 | Admin GET billing | status:"active", daysLeft:450, history×2 |
| 10 | Refund first payment | `kind:"refund", amountUsd:"-100.00000000"` |
| 11 | Credit $5 (under min) | 403 |
| 12 | Alice → admin endpoint | 403 |
| 13 | Anon → /me/billing | 401 |
| 14 | audit_log billing.* | address_allocated×2, credited_manual×2, refunded×1 |
| 15 | DB sanity | 2 addresses, 2 subscriptions ($400) + 1 refund (-$100) |
| 16 | **Grace block**: force-expire → Alice `status:"expired"`, POST refresh = **403**, admin POST = **202** |

## Ограничения

- **Реальные blockchain providers — skeletons**. Auto-credit pipeline
  работает целиком (insert into payment_transactions с conf threshold,
  credit ready txs), но `fetchIncoming()` возвращает `[]`. До Phase 8b
  все credit-ы идут через admin manual.
- **HD wallet нет** — static address pool из env. Когда пул кончится
  — `getOrAllocateAddress` бросает 409 «pool empty», admin докинет.
- **Confirmations threshold захардкожен на binary Tronscan response** —
  логика «confirmed → бесконечность conf-ов, не-confirmed → 0». Real
  refinement (учёт количества block-ов) — Phase 8b.
- **Refund не двигает `period_end`** — admin сам решает, отозвать ли
  подписку, через `setStatus` или дополнительный refund. Документировать
  workflow в admin manual.
- **Нет webhook reconciliation** — мы pull-им провайдеров каждые 5 мин.
  Можно ускорить через webhook (Tronscan webhooks, Etherscan webhooks),
  но beta scale не требует.
- **Тариф 30 дней = month** — не календарный месяц, чтобы не плодить
  edge-cases с високосными годами / 31-числом. Юзер платит «3 месяца»
  = 90 дней.
- **Beta-юзеры (без `subscription` rows) видят `status:"beta"`** —
  никакой grace, никаких блоков. Admin может вручную их `setStatus`
  blocked через Phase 5 endpoint, или дать $100 trial.
- **Cron refresh для expired** идёт — тратит платформенную квоту. Если
  начнёт болеть, легко добавить filter в worker bootstrap (только
  юзеры с `status in ('beta','active','grace','trial')`).
- **Notifications-hook**: PaymentMonitor пока не дёргает
  `NotificationsService.send(user, "payment_received", ...)`. Phase 8b
  свяжет — после credit отправлять email «оплата зачтена, period_end до X».
