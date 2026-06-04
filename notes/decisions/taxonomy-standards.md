# Стандарты таксономии для UCB-сервера (2026-06-04)

Эталонные перечни, на которые ориентируется обработка позиций. Цель: сервер
понимает ЛЮБУЮ позицию/операцию по **типу**, а не по названию протокола.

---

## 1. Типы ПОЗИЦИЙ (category) — авторитетный enum DeBank

DeBank даёт **полный конечный список** видов позиций (это наш `category` / `kind`).
Источник: `PortfolioItemObject` — `detail_types` (машинные) + `name` (UI-метка).

### `detail_types` (машинные, авторитетно из доки):
`common`, `locked`, `lending`, `leveraged_farming`, `vesting`, `reward`,
`options_seller`, `options_buyer`, `insurance_seller`, `insurance_buyer`,
`perpetuals`, `nft_common`, `nft_lending`, `nft_fraction`
(+ в др. версии: `nft_p2p_borrower`, `nft_p2p_lender`).
Приоритет растёт слева→направо (правый detail_type = самый детальный).

### `name` (UI-метки):
Yield · Deposit · Staked · Locked · Farming · **Leveraged Farming** · Lending ·
Vesting · Rewards · Airdrop · Liquidity Pool · Options Seller/Buyer ·
Insurance Seller/Buyer · Investment · Governance · **Perpetuals** ·
NFT Staked / NFT Liquidity Pool / NFT Lending / NFT Fraction / NFT P2P Borrower/Lender.

### Доп. поля по типу (для расчёта метрик):
- `lending` → supply+borrow (req) + `health_rate` (req).
- `leveraged_farming` → как lending + farming.
- `locked` → `unlock_at`. `vesting` → `daily_unlock_amount`, `end_at`.
- `perpetuals` → `side`(Long/Short), `entry_price`, `mark_price`, `liquidation_price`,
  `leverage`, `margin_token`, `pnl_usd_value`, `daily_funding_rate`.
- `options_*` → `exercise_end_at`, `usd_value`. `insurance_*` → `usd_value`.
- `reward` → `token_list`.

**Покрытие наших эталонов:** есть LP / Lending / Leveraged (Fluid/Morpho) / Yield / Staked.
**НЕТ эталонов:** Perpetuals, Options, Insurance, Vesting, NFT-* — добавить когда появятся.

---

## 2. Источник комиссий по LP = Krystal (НЕ классификация on-chain `collect`)

По LP-позициям (28 Krystal-протоколов) комиссии берутся из Krystal, авторитетно:
- `tradingFee: { pending:[TokenAmount], claimed:[TokenAmount] }` — торговые комиссии.
- `farmingReward: { pending:[TokenAmount], claimed:[TokenAmount] }` — эмиссия/farm.
- `performance.apr.{ totalApr, feeApr, farmApr }` (ДОЛИ, ×100 для UI).
- `earning24h`; `historicalPerformance[].{ feeEarned, farmReward }`.
- tx-типы Krystal: `ADD_LIQUIDITY / REMOVE_LIQUIDITY / INCREASE_LIQUIDITY /
  DECREASE_LIQUIDITY / COLLECT_FEE` — `COLLECT_FEE` = сбор комиссий.

→ **Вывод:** on-chain метод `collect` (Uniswap V3), который у нас падает в `unknown`,
для **Krystal-покрытых LP НЕ критичен** — комиссии уже даёт Krystal (`tradingFee.claimed` +
`COLLECT_FEE`). `collect`→unknown важен только для НЕ-Krystal V3-подобных / registry-only
потоков. Приоритет понижен.

---

## 3. Расширение базы знаний по типам ОПЕРАЦИЙ (op_type)

**Готового vendor-списка op_type НЕТ:**
- DeBank `history_list.cate_id` = только **3 грубых**: `send` / `receive` / `approve`
  (+ `tx.name` метод, `project_id` протокол). Семантику (lend_supply/lp_add/borrow) выводим МЫ.
- Etherscan = сырьё: метод (ABI), логи событий. Никакой семантики.
- Наши ~17 op_type — НАША таксономия (классификатор).

**Где брать сигнал, чтобы `unknown`→0 (по убыванию надёжности):**
1. **🥇 Сигнатуры СОБЫТИЙ (topic0)** — самый надёжный. События стандартизованы и описывают
   СЕМАНТИКУ напрямую (vs имена методов, что варьируются у роутеров): ERC20 `Transfer`,
   Uniswap `IncreaseLiquidity`/`DecreaseLiquidity`/`Collect`, Aave `Supply`/`Borrow`/`Repay`/
   `Withdraw`, staking `Staked`/`Withdrawn`, etc. → собрать словарь topic0→op_type.
   Etherscan `getLogs` + Alchemy `getLogs`.
2. **Наш собственный `unknown`-бакет** (итеративно) — каждый неопознанный метод → правило.
   Сейчас там: uniswap3 `collect` (9, →claim/Krystal), `transfer` без протокола (→transfer_in/out),
   `setApprovalForAll`/`approveForAll` (→approve), роутеры `execute`/`multicall`/`redeemDelegations`
   (→декодировать внутренние ops), points `bulkAddFxtlPoints`/`setTraderReferralCode` (→noop).
3. **4byte directory** (function selector → имя метода) для неизвестных селекторов.
4. **Etherscan `getContractAbi`/`getContractSourceCode`** — ABI контракта → имена методов.
5. **Alchemy `getAssetTransfers`** category (external/internal/erc20/erc721/erc1155) — надёжная
   категоризация переводов.
6. **DeBank `cate_id` (send/receive/approve)** — гарантированный грубый FALLBACK: если тонкий
   классификатор не опознал — всё равно знаем «приток/отток/approve» + движения → НИЧЕГО не
   остаётся истинно `unknown` (в худшем случае «приток, протокол X, метод Y»).
7. **Семантический фоллбэк по движению стоимости:** value IN из протокола → deposit-подобное;
   value OUT в протокол → supply-подобное; approve → шум; нет движения → noop (как points).
8. **Per-protocol декодеры** для сложных (GMX/Fluid/Morpho) — их специфичные события.

**Рекомендация архитектуры:** классифицировать по **СОБЫТИЯМ (topic0), а не по именам методов** —
события семантичны и стабильны; имена методов у роутеров (`execute`/`multicall`) бессмысленны.
DeBank send/receive/approve — как нижний гарантированный слой (unknown никогда не «теряется»).

---

## 4. Стартовый словарь `topic0 → op_type` (события, verified из эталонных tx 2026-06-04)

Классифицируем по **событию (topic0)**, не по имени метода. Проверено на реальных
эталонных tx (Arbitrum: UniV3 deposit, GMX mint, Morpho supply, Fluid supply).

### Tier 1 — универсальные ERC-стандарты (любой протокол, 100% надёжно)
| topic0 | событие | → op_type |
|---|---|---|
| `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` | ERC20 `Transfer(from,to,value)` | transfer_in/out (direction по from/to) — **базовый сигнал движения** |
| `0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925` | ERC20 `Approval` | approve (шум) |
| `0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7` | ERC4626 `Deposit(sender,owner,assets,shares)` ✅verified | lend_supply/lp_add (vault-депозит) |
| `0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db` | ERC4626 `Withdraw(...)` | lend_withdraw ⚠ verify |

### Tier 2 — Uniswap V3/V4 family (Uniswap/Pancake/Sushi/V3-форки; NPM + pool)
| topic0 | событие | → op_type |
|---|---|---|
| `0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f` | NPM `IncreaseLiquidity` ✅verified | lp_add |
| `0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4` | NPM `DecreaseLiquidity` | lp_remove ⚠ verify |
| `0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01` | NPM `Collect` | claim_rewards (fee) — **но для LP fee авторитет = Krystal** |
| `0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde` | pool `Mint` ✅verified | lp_add (pool-level) |
| `0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c` | pool `Burn` | lp_remove ⚠ verify |

### Tier 3 — Aave V3 family (Supply/Borrow/Repay/Withdraw) — Borrow/Repay ✅verified 2026-06-04, Supply/Withdraw канонические
| topic0 | событие | → op_type |
|---|---|---|
| `0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61` | `Supply` | lend_supply |
| `0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0` | `Borrow` | borrow |
| `0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051` | `Repay` | repay |
| `0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7` | `Withdraw` | lend_withdraw |

### Tier 4 — protocol-specific (нужен per-protocol декодер, НЕ хватает topic0)
- **GMX V2** ✅verified topic0 `0x468a25a7…` @EventEmitter — **ВСЕ события GMX идут через ОДИН
  EventEmitter с одним topic0**; реальное имя события (`DepositCreated`/`Withdrawal`/…) лежит
  В DATA (строковый параметр). → decode data, не topic0.
- **Morpho Blue** ✅verified @0x6c247b1f: per-event topic0 (`0xa58af1a0…`/`0xa3b9472a…`/`0x9d9bd501…`/
  `0xd5e969f0…` = Supply/SupplyCollateral/Borrow/…). Маппятся через Morpho ABI.
- **Fluid** ✅verified @0x324c5dc1/0x52aa8994: Fluid `LogOperate`-события (`0xfcc2278…`/`0x4d93b23…`/
  `0xfef6476…`). Маппятся через Fluid ABI.

→ Для Tier-4 (и любого нового протокола): fetch ABI (`getContractAbi`) → найти событие, чей
`keccak256(signature)==topic0` → имя события → эвристика (содержит Supply/Deposit→lend_supply/lp_add,
Borrow→borrow, Withdraw/Decrease→withdraw, Collect/Claim→claim).

## 5. Авто-расширение словаря (feedback loop, НЕ магия)

Словарь сам не пополняется, но проектируется **само-расширяющимся** циклом:
1. **`unknown`-детектор:** периодический скан (как Эпик C anomaly) находит op с `op_type='unknown'`
   → собирает их **новые topic0** (которых нет в словаре) → инбокс «новые сигнатуры».
2. **Авто-подсказка через ABI:** для нового topic0 → `getContractAbi(emitContract)` → найти событие
   `keccak256(sig)==topic0` → имя события → эвристический маппинг op_type (по ключевым словам выше).
   Человек подтверждает 1 кликом → добавляется в словарь.
3. **Гарантированный fallback** (пока словарь догоняет): DeBank `send/receive/approve` + движение
   стоимости (IN→deposit, OUT→supply, approve→шум, нет движения→noop) → **ничего не теряется как
   «unknown»**, в худшем «приток, протокол X, событие topic0=0x…».
4. **Регрессия:** каждый добавленный маппинг → закрепить эталоном/тестом (как golden), чтобы новый
   протокол нового юзера автоматически проходил.

Итог: новый юзер с новым протоколом → его события либо уже в словаре (Tier 1-3 покрывают
большинство DeFi), либо ловятся fallback'ом + авто-подсказка ABI ускоряет добавление. `unknown`→0
достигается итеративно через этот цикл, без ручного перебора всех протоколов.

## Связанные
- [[debank_cloud_api_reference]] — PortfolioItemObject, history_list, detail_types.
- [[krystal_cloud_api_reference]] — tradingFee/farmingReward/feeApr, COLLECT_FEE.
- `position-audit-protocol.md` §«Спецификация UCB-сервера от эталонов» (вывод #1: классификация — фундамент).
