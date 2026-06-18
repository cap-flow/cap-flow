# UCB — единый дом работы + чек-лист мёржа

> ⚠️ **ВЕТКА**: вся работа в `claude/capital-summary` (это condescending-fermi +
> продолжение; worktree-папка называется `condescending-fermi-99f0ac`, но git-ветка
> там = `capital-summary`). НЕ путать с замороженной `condescending-fermi`.
> Источник истины по методологии: `ucb-server-port-master-plan.md` (та же ветка).

---
## 🔄 ОБНОВЛЕНИЕ 2026-06-13 (АВТОРИТЕТНОЕ — заменяет устаревшие числа/флаги ниже)

Состояние ветки: **156 коммитов впереди main, 6 позади** (нужен reconcile main).

### Гейты (актуальные, перемерено 2026-06-13)
| | baseline для шага 2 |
|---|---|
| API тесты | **1187 / 82 файла** (было 1108–1162 в старом тексте) |
| WEB тесты | **781 / 64 файла** (было 753–757) |
| ucb tsc | 0 |
| api+web tsc | без новых ошибок vs последний прогон |
| миграции | **0 → 0033** (добавлена `0033_ucb_shadow_stages`) |

Старые числа в разделах ниже (api 1108 / web 753) — **исторические, не использовать**.

### Коммиты этой сессии (2026-06-11…13) — ОБЯЗАНЫ выжить после reconcile
- `047776e` конвейер движка — именованные этапы (PipelineTrace → `ucb_shadow_results.stages`, миграция 0033).
- `149939e` **F1**: histPrices в ledger-этап (transfer_in волатильного по рынку на момент). Инвариант: testakk Fluid ETH **$35 655.46**, Morpho **$21 566.19** (сверено on-chain).
- `da1061f` сервер = источник позиций фронта + гидрация методики per-user + бейдж «расчёт: сервер/браузер».
- `2a3b245` порт 4 V3-операций в `@cap-flow/ucb` (claimed-fees split, dedupe matchedV3TokenId, dust-фильтр + `KrystalV3Source.closedPoolKeys`, phantom-фильтр); web = re-export'ы.
- `044dc65` флаг **`capflow.feature.ucbServerOnly`** (браузер не считает вовсе).
- `f1f89f5` POST `/accounts/:id/ucb/recompute` (in-flight lock) + `useServerRecomputeOnMismatch` + view-mode read-only для lot-methodology (403).
- `899875e` авто-recompute на `no_shadow`/`not_served` (новый аккаунт грузит позиции).
- `745502b` добавление адреса → немедленный + recurring refresh (shadow для нового аккаунта).
- `56b3d2a` правило протокола «аудит всегда на серверном движке» + аудит moximko.

### Флаги (БД, НЕ едут через git merge — это строки в `feature_flags`)
**Прод едет с флагами OFF.** Локально я включал для проверки `ucbServerOnly`/`ucbServerCanonical` ON — это в локальной БД, мёрж их НЕ переносит.
- `ucbServerShadow` — ON (инертно: сервер считает в тень, не отдаётся).
- `ucbServerCanonical` — **OFF в прод** (юзеры на браузерном расчёте).
- `ucbServerOnly` — **OFF в прод** (новый; включать только в cutover, ПОСЛЕ shadow по всем аккаунтам — иначе непосчитанные увидят пусто, класс moximko).
- `chain_classifier.topic0.enabled` — OFF.

### ⚠ 3 изменения НЕ инертны даже при флагах OFF — осознанно принять ИЛИ спрятать за флаг
1. **Бейдж «расчёт: …»** рендерится всегда на листе позиций → при canonical OFF юзеры увидят «браузер · серверный расчёт выключен» (косметика, но видимо).
2. **Добавление адреса → refresh** (`745502b`) не за флагом → в проде ставит refresh при каждом добавлении кошелька (нагрузка на очередь; полезно, но не «ноль изменений»).
3. **F1 + порт V3** меняют **серверный** расчёт (shadow). Юзерам не видно (canonical OFF), но числа shadow изменятся → влияет на shadow-diff в cutover (это ожидаемо/желательно).

### Дополнения к чек-листу (к шагам ниже)
- Шаг 2: сверять с **новым** baseline (1187 / 781), не со старым.
- Шаг «миграции»: прогон **0→0033** на чистой БД (0033 добавлена этой сессией).
- Инварианты дополнить: testakk Fluid ETH $35 655 / Morpho $21 566 (on-chain-verified), порт V3 (web re-export'ы дают идентичные числа — старые 4 теста модулей зелёные), этапы конвейера пишут `stages` без изменения positions.
- Решить по 3 не-инертным пунктам выше ДО объявления мёржа «инертным».

---

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
