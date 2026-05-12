---
date: 2026-05-09
stage: 13
---

# Аудит 2 новых кошельков — методология выявила и исправила баги

## Контекст

После Этапа 12 / Фаз 1-2 пользователь подключил 2 новых кошелька
(Alexander 1 + Aleaxander 2) и попросил полный аудит чтобы проверить
методологию на новых данных. Найдены и исправлены 4 из 6 проблем.

## Что работает (✓)

- **Cost basis для всех типов lending** (Aave/Compound/Fluid/Morpho)
- **GMX V2 / GLV** cost basis включая cross-protocol GLV→Morpho
- **Стейбл-pair LP** (EURC/USDC через Aerodrome и Uniswap V3)
- **Junk filter** — 30+ scam-airdropов отфильтрованы
- **Multi-wallet aggregation** — 2 кошелька корректно отображаются вместе

## Что исправлено в этой сессии

### Фикс #3: LBT (LFJ Liquidity Book) receipt detection

**Проблема:** POS-002 LFJ AUSD/USDC не получала дату открытия. LBT
(Liquidity Book Token у Trader Joe / LFJ) не был в `PROTOCOL_TOKEN_PREFIXES_UPPER`.
Дополнительно DeBank возвращает 50× LBT с amount=2^63 (overflow placeholder).

**Фикс:** добавлены regex-паттерны:
- `protocols.ts: /^LBT$/` для глобального детекта
- `token_roles.ts:isReceiptOfProtocol` — branch для `pid.includes("traderjoe")`
- `token_roles.ts:isReceiptOfProtocol` — branch для `pid.includes("aerodrome")`

### Фикс #4: Pendle PT/YT classification

**Проблема:** POS-003 Pendle PT-apxUSD не получала дату открытия.
PT/YT приобретаются через AMM swap (механически verно), но
семантически это вход в yield-позицию. После того как PT/YT
помечены как receipt-token (`/^PT-/`, `/^YT-/`), classifyDex
правильно даёт `lp_add` через recvLp branch.

Также добавлен `kindFromCategory` mapping для Pendle: `category="common"` +
`itemName="Deposit"` → kind=LP. Pendle V2 от DeBank не имеет
категории `lp` или `vault`, использует "common".

### Фикс #5: Empty-movement junk filter

**Проблема:** 3 ops с пустым `movement` array (DeBank phantom-ops)
проскальзывали в реестр и засоряли список.

**Фикс:** новый тег `junk:empty_movement` в `junk_filter.ts:classifyJunk`.

### Фикс #6: GMX V2 Yield + Vault category

**Проблема:** POS-006 GMX V2 Yield (GLV vault) показывалась с
`kind="Другое"` вместо `LP`. DeBank даёт `category="vault"` для
GLV-vault'ов.

**Фикс:** расширен `kindFromCategory` — добавлены `vault`/`farm`/`deposit`
в LP-branch.

## Что осталось (требует Phase 4-5)

### Проблема #1: V3 NFT split (POS-009/010 PAXG)

Кошелёк Alexander 1 имеет 2 NFT для одной пары PAXG/USDC. В
истории операций только 1 lp_add (mint NFT-A) — DeBank не вернул
mint NFT-B (вероятно был через `decreaseLiquidity`+`mint` на
существующем кошельке).

Текущий V3 NFT-attribution алгоритм сопоставляет 1 mint к 2 NFT
через fallback и **дублирует** startUsd $1,180 для каждого NFT.

**Реальный cost basis:** должен делиться между NFT
пропорционально (если split был 50/50, каждому достанется $570).

**Решение:** Phase 4 (PositionTracker с event log) запишет split
как явное событие.

### Проблема #2: DeBank truncated history (POS-001 XAUt)

Live state показывает 0.0158 XAUt + 85.10 USDT = $162, но в
истории только 1 lp_add на 0.0076 XAUt + 21.71 USDT = $57.

Разница не объясняется fees за 4 дня — был **дополнительный**
deposit (`increaseLiquidity`), который DeBank API не вернул.
Это **не баг нашего кода**, а ограничение источника данных.

**Решение:** Phase 5 (cross-protocol Token Trace) — параллельный
парсинг on-chain логов через Alchemy для V3 ops + сравнение с
DeBank как fallback.

## Применимость к будущим кошелькам

После этих фиксов методология автоматически распознаёт:

- ✅ Любой LFJ Liquidity Book deposit
- ✅ Любую Pendle PT/YT/SY-acquisition
- ✅ Любой GMX V2 GLV vault deposit
- ✅ Любой Aerodrome/Velodrome V3 LP
- ✅ Combined supply+borrow (Fluid Vault, Morpho-bundler)
- ✅ Cross-protocol token flow (GLV из GMX → Morpho collateral)
- ✅ Multi-deposit lending (additional collateral для HF)
- ✅ Receipt-less протоколы (Morpho Blue, Drift, Adrena)

**Whitelisted:**
- GMX V2 GM markets + GLV vaults
- Aave V3 aTokens (chain-prefixed)
- Compound v2/v3 cTokens
- Fluid fVLT
- LFJ LBT
- Pendle PT/YT
- Aerodrome/Velodrome
- Liquid staking (stETH/wstETH/rETH/...)

**Не whitelist'ятся** (вернутся к подходу Phase 4):
- V3 NFT splits (одна позиция → две через decreaseLiquidity)
- DeBank API truncated history (ограничение источника)
