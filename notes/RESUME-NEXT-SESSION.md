# Промт для старта новой сессии (Capflow UCB server-port)

> Скопируй блок ниже в новую сессию Claude Code. Он самодостаточен.

---

Продолжаем Capflow UCB server-port. Прежде чем что-либо делать — прочти память
`capflow_ucb_b5_state` и `notes/decisions/ucb-server-port-master-plan.md`, затем
сверь фактическое состояние (см. «Проверка состояния» ниже).

## ⚠️ КРИТИЧНО: worktree
Вся работа в **`/Users/vladimir/Desktop/cap-flow (для блокчейна)/.claude/worktrees/condescending-fermi-99f0ac`**
(ветка `claude/condescending-fermi-99f0ac`). Session-root — ДРУГОЙ, СТАРЫЙ worktree
(`romantic-brahmagupta`, без `packages/ucb`, миграции до 0024). Все Bash —
`cd "<...>/condescending-fermi-99f0ac" && ...` (путь в двойных кавычках: пробелы +
кириллица). Проверка: `ls packages` должен показать `db ucb`. ⚠ В путях для
Read/Write НЕ опечатайся в «vladimir» (кириллическая «в» ломает путь).

## Где мы (на момент сохранения)
- **27 коммитов на ветке, НЕ в main/прод** (LOCAL-FIRST, owner-решение Q5; main
  авто-деплоит в прод). Дерево чистое.
- **Серверный порт UCB функционально завершён:** B5 (compute-only оркестратор) +
  B2 (CEX inheritance) + B3 (V3 enrichment через Krystal) — все провязаны в
  worker + Fastify route, и **приёмка на живом testakk: сервер == клиент на ВСЕХ
  14 позициях (14 match / 0 diverge / 0 missing)** — lending, GMX, Fluid, Morpho,
  Uniswap V3. Цифра-в-цифру на реальных данных.
- Гейты: api **980/980**, web golden зелёный, tsc чист (auth/cex baseline-ошибки
  НЕ мои).
- Тест-аккаунт **testakk** (`d96e847e-f030-47e5-82d6-8b0d5b2cf01f`), кошельки
  artur (`e8af7df9`, `0x3df3ce31…6a38`) + murat (`b604cf12`, `0x1bd62bdb…d041`).

## Проверка состояния (запусти, должно совпасть)
```bash
cd "/Users/vladimir/Desktop/cap-flow (для блокчейна)/.claude/worktrees/condescending-fermi-99f0ac"
git log --oneline -1            # → 21d0698 ... B3.10 acceptance ... ALL 14
cd apps/api && npx vitest run src/modules/ucb/        # ucb-юниты зелёные
# Полная приёмка сервер==клиент на живых данных (DeBank+Krystal calls):
npx tsx --env-file=../../.env scripts/ucb-shadow-acceptance.mts   # пишет shadow row
npx tsx --env-file=../../.env scripts/ucb-shadow-verify.mts       # → 14 match / 0 / 0
```

## Что осталось (по приоритету)
1. **B6 — флип serving** (go-live фаза, отдельная): UI читает серверные canonical-
   значения (`ucb_shadow_results`) за per-user флагом `capflow.feature.ucbServerShadow`
   (уже есть в admin-реестре), с permanent client-recompute fallback. ⚠ по плану —
   ТОЛЬКО после устойчивого shadow-diff паритета в проде. Нужен serving-endpoint +
   UI-чтение. См. мастер-план §B6.
2. **Мердж в main** (= выкатка в прод) — твоё решение; сейчас всё на ветке.
3. **Задача #18** — artur ETH Fluid: server `computePositions` $33704 vs live-client
   $32296 (+4.4%, в допуске soft-anchor). НЕ CEX, НЕ аннотации (исключено), НЕ V3.
   Реальная разница в LIFO-потреблении лотов: кандидаты — порядок ops, cross-wallet/
   internal-transfer linking. Диагностировать lot-trace обоих путей.
4. **B3-full** (completeness, НЕ нужно для testakk): порт slot0/Etherscan V3
   cost-basis (steps 2/3/6/7 из плана `wmxeoa99v`) для НЕ-Krystal-covered V3 LP.

## Архитектура серверного порта (apps/api/src/modules/ucb/)
- `ucb.service.ts::computePositions(wallets, deps)` — ядро: runUcbPipeline →
  buildOpenPositions → lending → CEX(B2) → Krystal-V3(B3). Импорт ТОЛЬКО из `@cap-flow/ucb`.
- `debank-live.adapter.ts` — DeBank→LiveSnapshot (B5 6a).
- `ucb-ops.repository.ts` — chain_operations.raw → ClassifiedOp[].
- `ucb-shadow.repository.ts` / `ucb_shadow_results` таблица (миграция 0030).
- `ucb-shadow.service.ts` (flag-gated, fail-soft) / `ucb-shadow-runner.ts` (live+CEX+Krystal sources).
- `krystal-v3.source.ts` + `integrations/krystal.ts` (B3).
- `shadow-diff.ts` + `ucb-shadow-diff.handler.ts` + `ucb.routes.ts` (POST /accounts/:id/ucb/shadow-diff).
- Krystal-движок портирован в `packages/ucb/src/krystal/` (web = re-export шимы).

## Правила (owner, locked)
- LOCAL-FIRST, не флипать в прод без подтверждения; main = прод.
- Эталон = реестр операций; методика в `notes/golden/knowledge-base.md` §8.
- LP cost basis → Krystal (28 протоколов авто-роут). Объяснять простым языком.
- Test-first; гейтить каждый шаг; не коммитить в main без явного «да».
