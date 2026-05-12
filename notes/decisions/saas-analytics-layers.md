---
date: 2026-05-11
stage: SaaS Phase 2 (planning)
---

# Разделение слоёв «методики анализа портфеля» в SaaS

## Контекст

Capflow считает много вещей: cost basis (FIFO + openHash override), IL для
Uniswap V3, PnL по позициям, идентификацию LP / lending позиций, dividends,
healthness Aave-кредитов. До SaaS всё это считалось на клиенте, под одного
владельца. В SaaS встаёт вопрос: для 25+ пользователей **где живёт
«методика»** — у каждого своя копия или одна общая?

Существующая БД (наследованная схема) сделала **много per-account таблиц**:
`networks`, `custom_cg_ids`, `token_prices`, `tokens`, `lp_pairs`,
`address_labels`, `position_types`, `position_custom_cols`. Это означало
дубликаты reference-данных у каждого юзера и невозможность сделать единый
технический аудит.

## Решение

**Три слоя**, явно разделены:

### 1. Алгоритмы (код) — единая методика для всех
Сам код расчётов (cost basis, V3 exit math, IL, identification) — это
программа, не данные. Один экземпляр обслуживает всех. Существующие
методики уже задокументированы в `cost-basis-architecture.md`,
`lp-cost-basis.md`, `receipt-token-cost-basis.md`, `v3-etherscan-cost-basis.md`.

**Версионирование через `feature_flags`** (per-scope: global / account / user):
- Новая версия алгоритма → `enabled=false, scope=global` + `enabled=true, scope=user, scope_ref_id=admin`
- Обкатал на себе → `scope=user` для 5 бета-юзеров
- Стабилизировал → `enabled=true, scope=global`

### 2. Reference data — глобальная, с возможностью per-account override
Данные, которые **по природе одинаковые у всех**: chain registry,
`symbol → coingecko_id`, базовые address labels, исторические цены.

| Что | Сейчас | Должно быть |
|---|---|---|
| `chain_id → name / provider / fee_token` | `networks` per-account | **global** `chain_registry`; per-account только для custom RPC |
| `symbol → coingecko_id` (USDC, WETH, …) | `custom_cg_ids` per-account | **global** `coingecko_registry` + per-account `cg_id_overrides` для экзотики |
| Метки адресов (Aave V3 Pool, Uniswap router) | `community_labels` global ✓ + `address_labels` per-account ✓ | оставить как есть |
| Token prices (5 мин TTL для current) | `token_prices` per-account | **global** Redis cache + персистентная global `historical_prices` (на дату) |

### 3. User data — per-account, изолированная
Никогда не пересекается с чужим юзером:
- `operations`, `imported_operations`, `deleted_ops`, `account_counters`
- `wallets`, `wallet_addresses`
- `portfolio_snapshots`, `position_meta`, `position_div_collects`
- `lp_pairs`, `projects`, `tokens` (если юзер сам импортировал)
- `address_labels` (приватные ярлыки кошельков юзера)
- `position_types`, `position_custom_cols`, `cg_id_overrides`

Изоляция enforced на уровне SQL через middleware и явный фильтр по
`owner_id`/`account_id` в каждом query (Phase 2).

## Альтернативы

- **Полностью per-account методика** (как было). Отвергли:
  - Невозможен общий технический аудит (требование владельца — «найти
    закономерные ошибки у юзеров»).
  - Дубликаты reference-данных у каждого юзера → лишние API-вызовы → быстрее
    исчерпываются лимиты Alchemy/DeBank.
  - Исправление бага алгоритма требует выкатывать у всех; нет
    рассинхрона между «новой» и «старой» версиями.
- **Полностью global без per-account overrides**. Отвергли: реальная
  потребность есть в overrides для экзотических токенов (не все есть в
  CoinGecko), custom labels кошельков, custom RPC.
- **Версионирование через VERSION-колонку в каждой таблице** (вместо
  feature_flags). Отвергли: feature_flags уже спроектирован под scope-based
  targeting (Phase 6), не плодим параллельную инфраструктуру.

## Реализация

**Phase 2** (multi-tenant + рефакторинг reference data):

1. **Создать global reference таблицы**:
   - `chain_registry` (chain_id PK, name, fee_token, default_provider, …)
   - `coingecko_registry` (symbol PK, coingecko_id, contract_addresses jsonb)
   - `historical_prices` (symbol, date, price_usd) — глобальная.
2. **Сидировать** базовыми значениями (Ethereum, Arbitrum, Base, Optimism,
   Polygon, BNB, Avalanche → chain_registry; USDC, USDT, WETH, WBTC и т.д.
   → coingecko_registry).
3. **Per-account оставить только overrides**:
   - `networks` → переименовать в `account_networks` или удалить (если
     custom RPC не востребован — выкинуть, использовать global).
   - `custom_cg_ids` → переименовать в `cg_id_overrides` (юзер добавляет
     только то, чего нет в global).
   - `token_prices` per-account → дроп; current prices — Redis global; historical
     — `historical_prices` global.
4. **Миграция**: пройти по существующим per-account записям, дедуплицировать
   в global (там сейчас минимум данных, наследованных от прошлой попытки),
   старые таблицы дропнуть.
5. **Compute layer** — модуль `apps/api/src/modules/portfolio/`:
   - Pure-функции `costBasis(operations, prices, refdata)`, `il(v3pos, prices)`,
     `pnl(positions, prices)`. Без I/O — на вход всё, что нужно.
   - Сервис-обёртка собирает входы из global + per-account слоёв,
     вызывает pure-функции, складывает результат в `portfolio_snapshots`.
6. **Worker** (Phase 4): hourly cron пробегает по аккаунтам, пересчитывает
   снапшоты. Юзер видит snapshot мгновенно, без живых API-вызовов на каждый
   запрос.

## Ограничения

- **Миграция reference-данных не идемпотентна автоматически**: при первом
  глобализации нужно вручную дедуплицировать (USDC встречается у 25 юзеров
  как 25 одинаковых записей). На beta с 1 юзером — легко; на 25 — скрипт.
- **Custom RPC per-account** — фича возможно появится в будущем. Сейчас
  выкидываем, но `chain_registry` спроектируем так, чтобы потом можно было
  override через `account_chain_overrides`.
- **Feature flags для алгоритма версионирования** требуют чтобы код был
  написан с явным branching: `if (await flags.enabled('cost_basis_v2', { userId })) { v2(...) } else { v1(...) }`. Это **руками** в коде, не магия — но
  держит обе версии параллельно работающими.
- **Технический аудит** работает корректно только если все юзеры на одной
  версии алгоритма. Когда юзеры разнесены по версиям через флаг —
  аудит-результаты надо группировать по версии.
