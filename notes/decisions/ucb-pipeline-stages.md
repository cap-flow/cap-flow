# UCB конвейер — именованные этапы движка (2026-06-12)

**Решение owner:** «сначала разложим текущий движок на этапы, фиксы потом — поверх
этапной структуры». Идея n8n-оркестрации отклонена (логика вне тестов, второй мозг,
недетерминизм); вместо этого — этапы внутри кода + BullMQ (уже в стеке) + статусы.

## Что сделано (commit `047776e`, ветка `claude/capital-summary`)

`apps/api/src/modules/ucb/pipeline-trace.ts` — PipelineTrace: каждый шаг движка
обёрнут в именованный этап со статусом ok|warn|fail|skipped, длительностью,
метриками, warnings. Логика расчёта НЕ менялась (гейт: positions идентичны с/без
trace; ucb-тесты 96/96). Запись — `ucb_shadow_results.stages` (миграция 0033).

Канонические этапы:
```
sources.cex → sources.krystal → sources.live → load.ops → link → ledger
→ price → build → override.v3 → override.lending → override.cex
→ override.krystal → override.opener → verify.tracker
```

## Что это даёт (привязка к аудиту melody789789, notes/audits/)

- **F5 (Krystal 402 молча):** `sources.krystal` теперь warn с текстом ошибки.
- **Прайсер:** «85 ops без исторической цены» — warn этапа `price` (раньше console.log).
- **F2 (override подменяет верное):** каждый override-этап пишет per-position
  дельты `startUsd from → to`. Прогон melody показывает прямо в трейсе:
  `override.opener: 630.92 → 526.98` (spot-подмена 0x7c11), `608.55 → 317.08`
  (чужой рынок 0x450b), `override.v3: 362.88 → 400.02`.
- **F1 (display ≠ SoT):** `verify.tracker` warn при расхождении >5%.

Просмотр: `ucb-compute.mts <email> --lifo` печатает таблицу конвейера; воркер
пишет stages при каждом shadow-прогоне.

## Следующие шаги (согласованный порядок)

1. **Фиксы 4 багов melody поверх этапов** (атрибуция переводов lending →
   cross-market матч GM → spot-подмена 0x7c11 → Aerodrome NFT + прайсер 0 filled),
   каждый с failing-тестом этапа.
2. Экран конвейера в админке (читает stages из ucb_shadow_results).
3. Confidence-гейт на override-этапы («прикидка не затирает факт») — точка
   врезки готова: дельты уже фиксируются.

## Ловушка веток (повторно!)

Канон движка = **`claude/capital-summary`** (condescending-fermi + 18..19 коммитов,
включая sequential-WAC `d2f7187`). Сама `condescending-fermi` заморожена на 08.06 —
там НЕТ последовательной WAC (давала 498.76 вместо 469.26 на melody GMX 0x70d9).
Worktree-папка называется `condescending-fermi-99f0ac`, но ветка в ней — capital-summary.
