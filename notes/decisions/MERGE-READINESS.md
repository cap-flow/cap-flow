# UCB — единый дом работы + чек-лист мёржа

> Эта ветка `claude/condescending-fermi-99f0ac` — **единственное место** всей
> работы по серверному порту UCB, детектору аномалий и golden-датасету.
> На 2026-06-04 она ~99 коммитов впереди `main`. Мёрж = одна операция
> (condescending-fermi → main). Код НЕ разбросан по веткам.
>
> Источник истины по методологии: `ucb-server-port-master-plan.md` (та же ветка).

## Что в этой ветке (по трекам)

**Серверный порт UCB (Epic A+B)** — код полностью готов локально:
- Движок вынесен в `@cap-flow/ucb`, серверный shadow-compute, B1–B6.
- `981c9d0` — порт async-deposit linker на сервер (GMX receipt-токены cross-protocol).
- `137141d` — cost basis залога на занятый стейбл = уплаченный номинал (PT-плечо).
- `cc90579` + `d0c4ed7` — детерминированный V3 NFT-матчинг по nftId (DeBank description).

**Детектор аномалий (Epic C)**:
- Pre-port SQL-чеки (admin-tech-audit) + post-port чеки (golden_case_drift и др.).
- `81eace1` — новые проверки + UI ack/resolve/promote.
- `75ca947` — убраны ложные срабатывания (cost_basis_from_spot, fee_apr).
- Re-scan Alice: 0 ложных, golden_case_drift 0/12.
- `d118358` — **`client_server_cost_basis_divergence`** чек поверх diff_summary:
  ловит класс POS-011 (клиент кормит движок неполным набором ops), который
  server-only чеки пропускают. +6 тестов.
- **Системный скан server-shadow всех 9 аккаунтов** (2026-06-08): 0
  инвариант-флагов (lp_uncovered_nearzero / pnl_impossible / cost_basis_from_spot)
  → сервер корректен везде. ⚠ divergence-чек пока без данных: клиент НЕ шлёт
  shadow-diff POST автоматом (нужен worker+флаг `ucbServerShadow` ON) → 0/247
  shadow-строк имеют diff_summary. Прод-докрутка: включить shadow-diff поток.

**Golden-датасет**:
- `d7c74d7` — дедуп эталонов по active position_key + миграция `0032` (требует прогона на БД).
- `30b1b49` + `845b6ee` — 12 эталонов Alice (выверены от реестра) + ledger
  `notes/golden/alice-2026-06-04.md` + сидер.

**Гейты (на момент последней проверки):** api 1108, web 753, engine+V3 63/63,
artur+murat shadow-verify 14/14, tsc baseline.

## ✅ Чек-лист мёржа (по порядку)

1. **Свериться, не разошёлся ли `main`** с базой ветки (`git log condescending-fermi..main`);
   если main ушёл вперёд — сначала rebase/merge main в ветку, решить конфликты.
2. **Миграции:** на dev уже прогнаны `0031` (users.lot_methodology) + `0032`
   (golden active position_key) — чисто, 0 коллизий. На **проде** прогонятся при
   деплое (миграция-first гейт).
3. **Редеплой API** — закрывает app-слойную защиту от null-ключей golden (роут
   требует непустой positionKey). До рестарта старый код ещё пускает null.
4. **Переразметить из UI 12 «бедных данными» эталонов** (artur/murat/egorov
   GMX/Fluid/Morpho — якорь display-only по position_id; tokenId/openHash в БД нет).
   ⚠ Сюда же по-хорошему 12 Alice-эталонов: засеяны синтетическим ключом
   `alice-2026-06-04:*` (0032 не была применена на момент сидинга) → перемеить из
   UI для точного positionKey, иначе UI-разметка создаст дубль.
5. **Флаги OFF по умолчанию** (`ucbServerShadow`/`ucbServerCanonical`) — мёрж
   ничего не меняет для юзеров, пока флаг выключен.
6. **Прод-выдержка shadow ≥2 недели** (серверный расчёт == клиент) → затем
   **флип флага** канонического расчёта.

## Рекомендуемая страховка ПЕРЕД мёржем

- **Системная проверка остальных юзеров** на 2 пофикшенных класса cost basis
  (async-receipt cross-protocol + borrowed-stable leverage) — как делали с Alice,
  но по всем кошелькам. Войти в прод с уверенностью, что фиксы покрыли всех.

## Известные остатки (не блокеры)

- DeBank иногда временно не возвращает позицию в ответе (alex1 uniswap3 → 0 items) →
  набор позиций «гуляет» в dev-харнессе. Прод сглаживает замороженным снапшотом.
  Опц. follow-up: «snapshot stickiness».
- Детектор: тяжёлый BullMQ+anomaly_flags путь — опционален; pre-port работает
  через admin-tech-audit.
