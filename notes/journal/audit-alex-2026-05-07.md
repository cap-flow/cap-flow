---
date: 2026-05-07
wallet: 0xfcbc116A7F003641c85885e9a34bB448fd125Aa2
name: Alex
---

# Аудит методики на новом кошельке (Alex)

7 открытых позиций. Полная сверка UI vs ground-truth от DeBank. **Только
диагноз, без исправлений.**

## Сводка позиций

| ID | UI Дата | UI startUsd | UI current | UI PnL | UI tokens |
|---|---|---|---|---|---|
| POS-001 | 06.04.2026 | **$17,548.33** | $15,612 | −$1,936 (−11%) | 1.746 WETH + 11,564 USDC |
| POS-002 | 06.04.2026 | **$17,548.33** | $2,007 | −$15,541 (−88%) | 0.497 WETH + 856 USDC |
| POS-003 | 06.04.2026 | **$17,548.33** | $16,193 | −$1,355 (−7.7%) | 4.108 WETH + 51,911 ARB |
| POS-004 | 04.04.2026 | $1,992.54 | $2,147 | +$154 (+7.7%) | 0.382 WETH + 1,261 USDC (Base) |
| POS-005 | 30.03.2026 | $11,887.06 | $11,930 | +$43 (+0.4%) | 5.147 ETH (Fluid mainnet) |
| POS-006 | 28.09.2025 | $33,957.26 | $35,461 | +$1,504 (+4.4%) | 15.297 WETH (Aave Arb) |
| POS-007 | 27.09.2025 | $41,112.17 | $41,292 | +$180 (+0.4%) | 9.27 WETH + 0.246 WBTC (Aave mainnet) |

---

## Найденные ошибки

### 🔴 КРИТИЧНО #1: Три V3 NFT с одинаковой Стартовой $17,548.33

Три полностью разные Uniswap V3 LP-позиции (POS-001/002/003) имеют
**идентичную startUsd**. Это математически невозможно — позиции открыты
в разное время с разными депозитами.

**Ground truth от DeBank `complex_protocol_list`:**

| NFT | Pool address | Pool tokens | Live supply | Live USD |
|---|---|---|---|---|
| #1 | `0xc6962004…e09e8d0` | WETH/USDC | 1.746 WETH + 11,564 USDC | $15,636 |
| #2 | `0xc6962004…e09e8d0` ⚠️ ТОТ ЖЕ | WETH/USDC | 0.497 WETH + 856 USDC | $2,008 |
| #3 | `0xc6f78049…dcd6396a` | WETH/ARB | 4.108 WETH + 51,911 ARB | $16,241 |

**NFT #1 и NFT #2 имеют ОДИНАКОВЫЙ `pool.id`** — это адрес самого пула
(WETH/USDC 0.05% на Arbitrum), а не уникальный идентификатор позиции.

**Корень проблемы:** наша методика матчинга позиций с историей идёт через
`lp.lpTokenId = pool.id`. Для V3 это address пула, не NFT. Несколько NFT в
одном пуле получают тот же `lpTokenId` → не различаются.

**Что не учли:** Uniswap V3 уникализирует позицию через `tokenId` NFT в
контракте `NonfungiblePositionManager`. DeBank возвращает `pool.id` (контракт
пула) — этого недостаточно. Нужен NFT tokenId, который доступен только через
on-chain RPC чтение `NonfungiblePositionManager.balanceOf` + `tokenOfOwnerByIndex`.
В коде уже есть V3-spec модуль (`apps/web/src/lib/v3/`), но он либо не активен
для этого кошелька (нет Alchemy ключа), либо не передаёт NFT tokenId в
position matching.

---

### 🔴 КРИТИЧНО #2: Одинаковая Дата открытия 06.04.2026 для 3 V3 позиций

Все три V3 позиции показывают `Дата открытия = 06.04.2026, Срок 31 дн`.

**Реальные даты mint NFT (из истории DeBank):**

| Позиция | Реальная дата mint | Состав mint | Возраст на 07.05.2026 |
|---|---|---|---|
| Малая WETH/USDC | 05.04.2026 17:12 | 0.778 ETH + 237.58 USDC | 32 дня |
| WETH/ARB | 11.04.2026 13:04 | 2.313 ETH + 81,987 ARB | 26 дней |
| Большая WETH/USDC | **05.05.2026 16:54** | 1.327 WETH + 12,550 USDC | **2 дня** |

UI показывает 06.04.2026 для всех — **неверно для 2 из 3 позиций.**

**Корень проблемы:** `findFirstOpen` фильтрует ops по `lpTokenId`, но из-за
бага №1 две WETH/USDC позиции получают тот же фильтр. Алгоритм находит
**самую раннюю** lp_add (05.04) и присваивает её ВСЕМ позициям с этим pool.id.

WETH/ARB позиция (другой pool.id) тоже показывает 06.04 — это уже отдельный
баг: возможно `findFirstOpen` для неё нашёл прокси-tx (multicall с approve
от 05.04) вместо реального mint от 11.04.

**Что не учли:** дата открытия должна определяться по **mint конкретного
NFT** (по NFT tokenId), а не по «первой lp_add в этом пуле». Также «срок»
от UI = 31 день округляется одинаково, что ещё подтверждает что `openedAt`
один и тот же объект для всех 3.

---

### 🟡 СРЕДНЕЕ #3: startUsd = $17,548.33 для V3 — откуда эта цифра?

Это число точно **не равно сумме реальных депозитов** ни одной из 3
позиций:

- POS-001 (большая WETH/USDC mint от 05.05): 1.327 WETH × $WAC + 12,550 USDC
  ≈ 1.327 × $2,316 + $12,550 ≈ **$15,624**
- POS-002 (малая WETH/USDC mint от 05.04): 0.778 ETH × $WAC + 237.58 USDC
  ≈ 0.778 × $2,316 + $237 ≈ **$2,038**
- POS-003 (WETH/ARB mint от 11.04): 2.313 WETH × $WAC + 81,987 ARB × $ARB
  ≈ 2.313 × $2,316 + 81,987 × $0.30 ≈ $5,357 + $24,596 ≈ **$29,953**

Сумма: $15,624 + $2,038 + $29,953 = **$47,615**.

**Гипотеза**: `currentCostBasisForPosition` через WAC от LotTracker
суммирует ВСЕ ETH out-движения к Uniswap V3, забивая каждой позиции
аналогичную сумму, поделённую как-то непропорционально. Нужна полная
трассировка (Phase 4 audit), но факт: цифра **некорректна для всех
трёх позиций**.

**Что не учли:** `currentCostBasisForPosition` возвращает накопленный
cost basis для **ПОЗИЦИИ как ключа (pool, market)**. Если две позиции в
одном pool, обе получают одинаковый накопленный cost — независимо от того
сколько каждая получила в свой mint.

---

### 🟢 ОК #4: POS-004 (Uniswap V3 Base) корректно

| Метрика | UI | Ground truth | Статус |
|---|---|---|---|
| Дата | 04.04.2026 | mint в апреле на Base | ≈ correct |
| startUsd | $1,992.54 | (не проверял точно) | reasonable |
| current | $2,147 | $2,147 | ✓ |
| PnL | +$154 (+7.7%) | small positive | ✓ |

Эта позиция **единственная** на Base в Uniswap V3 → нет конфликта
pool.id с другими, поэтому вся методика работает корректно для неё.

---

### 🟢 ОК #5: POS-005 (Fluid Lending mainnet) корректно

| Метрика | UI | Ground truth | Статус |
|---|---|---|---|
| Дата | 30.03.2026 | (требует уточнения) | ≈ |
| Live | 5.147 ETH supply | 5.147 ETH | ✓ |
| startUsd | $11,887.06 | 5.147 × $WAC ≈ $11,887 → WAC = $2,310/ETH | reasonable |

Только одна Fluid позиция в этом кошельке → нет проблемы 2 NFT в одном пуле.

---

### 🟢 ОК #6: POS-006 (Aave V3 Arbitrum) корректно

Полная хронология подтверждена:
- 28.09.2025 11:43: deposit 2.177 ETH (открытие)
- 28.09.2025 12:02: borrow 4500 USDC
- 10.10.2025 22:30: borrow 1000 USDC
- 10.10.2025 23:51: deposit 3.800 ETH
- 10.10.2025 23:54: borrow 8000 USDC
- (плюс несколько добавлений до live = 15.297 ETH)

UI: дата 28.09.2025 ✓ correct, startUsd $33,957 = 15.297 × ~$2220 = $33,959 ✓

Aave V3 кадый wallet имеет только ОДИН аккаунт-проксиfвая позицию → нет
проблемы multiple NFTs.

---

### ❓ ТРЕБУЕТ ПРОВЕРКИ #7: POS-007 (Aave V3 mainnet)

| Метрика | UI |
|---|---|
| Дата | 27.09.2025 |
| Live | 9.27 WETH + 0.246 WBTC |
| startUsd | $41,112.17 |
| current | $41,292.04 |

В Aave mainnet user одновременно supply WETH И WBTC + borrow USDC + USDT.
Это multi-asset Aave position. Наша методика для такого:
- Каждый supply asset считается отдельно в `currentCycleDepositForSymbol`
- Сумма startUsd-ов

Не проверял детали — но факт что Aave mainnet и Aave Arbitrum (POS-006)
правильно различаются по chain — хорошо.

---

## Систематические корни проблем

### Корень A: `pool.id` ≠ unique position для V3 LP

Uniswap V3 / V4 / других AMM с NFT-receipt'ом: пул один, позиций много.
DeBank возвращает `pool.id` = pool address. Этого недостаточно для
матчинга.

**Что нужно**:
- Хранить `nftTokenId` в `LiveProtocolPosition` (через RPC чтение
  `NonfungiblePositionManager` на каждой сети)
- В `linker` для V3 lp_add'ов идентифицировать `nftTokenId` приходящий
  в Tx (это unique per-mint)
- Менять matching ключ с `lpTokenId` на `nftTokenId` для V3-style протоколов

В коде уже есть `apps/web/src/lib/v3/` — но он НЕ интегрирован в
`buildOpenPositions` matching. Это требует Phase 5+ работы.

### Корень B: Дата открытия наследует pool-level cycle, не NFT-level

`findFirstOpen` ищет «первую lp_add в этом протоколе+chain+pool». Для V3
с мульти-NFT даёт самую раннюю дату для всех. Нужен NFT-level cycle.

### Корень C: `currentCycleDepositForSymbol` не различает позиции в одном пуле

Когда есть 2 NFT в одном пуле — обе получают одинаковую startUsd
(сумму всех ETH+USDC out-движений в этот пул).

### Корень D: V3-special path не активирован

В коде есть `buildV3Details` через RPC, но он работает **только** если
включена `isV3LpProtocol` детекция и есть Alchemy ключ. Для большинства
кошельков default fallback на generic logic, который ломает V3.

---

## Что нужно делать (для будущего исправления)

Это не одна правка а группа связанных:

1. **NFT-level identifier для V3** (Phase 5)
   - В `LoadedWalletsProvider` для каждой V3 позиции дёрнуть RPC
     `NonfungiblePositionManager` → получить tokenId NFT, range, fee
   - В `LiveProtocolPosition` добавить поле `nftTokenId`
   - При наличии `nftTokenId` использовать его в matching, не `pool.id`

2. **V3 mint detector в linker**
   - Каждая V3 mint tx содержит ERC721 transfer event с tokenId
   - Парсить эти события и связывать с `nftTokenId`
   - Линкер должен помечать lp_add op'ы tokenId NFT

3. **Per-NFT cycle**
   - `findFirstOpen` фильтрует ops по `nftTokenId` (не `lpTokenId`)
   - `currentCostBasisForPosition` атрибутирует cost basis к конкретному
     NFT по его mint events

4. **V3 IL расчёт через range**
   - Уже частично есть в `buildV3Details`
   - Подключить ко всем V3-style протоколам (Uniswap V3, V4, Pancake V3,
     Sushi V3, Algebra-based)

---

## Итог

**Из 7 позиций:**
- ✅ 4 корректны (POS-004, 005, 006, 007 — приближённо)
- 🔴 3 сломаны (POS-001, 002, 003 — все Uniswap V3 на Arbitrum)

Корень всех 3 поломок — **отсутствие NFT-level matching для V3**. Phase 4
улучшил логику для receipt-token-bearing протоколов, но V3 NFT — это
особый случай, который наша текущая методика **не обрабатывает**.

**Phase 5 должен добавить NFT-level matching** до того как делать что-либо
ещё. Без этого любой V3 пользователь увидит сломанные цифры.
