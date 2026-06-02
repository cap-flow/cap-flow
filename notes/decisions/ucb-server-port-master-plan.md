# Capflow — Server-side UCB Port: Master Implementation Plan

> Status: PLAN (not yet started). Authored 2026-05-30 via multi-agent workflow.
> Scope: build a server-side UCB engine + golden-dataset regression tests + cross-user
> anomaly detector. Test LOCAL-FIRST against `bob@example.com`, then promote dark to prod.

## North star & dependency graph

**North star.** Today the canonical cost-basis / PnL methodology (UCB: the lot tracker + `cross_protocol` position builder + the three overrides) lives only in the browser inside `useComputedPositions`, while the server runs a *simpler, drifted* WAC (`apps/api/src/modules/cost-basis/cost-basis.ts`) that ignores lots, the overrides, and `chain_operation_annotations`. We will make the server compute the **same numbers as the client** by extracting the engine into one shared package, persisting the enrichment inputs the engine needs, running the engine server-side in **shadow mode**, proving byte-parity against the client on a set of frozen golden anchors (POS-011 $237.80, EUR-stable, WBTC/BTC aliasing, C11), and only then flipping the UI to read server-computed canonical values behind a per-user flag with a permanent client-recompute fallback. Everything is built LOCAL-FIRST against `bob@example.com`, gated by golden regression tests and a shadow-diff, then promoted dark to prod. A scheduled anomaly detector continuously re-trips on any known incident, and resolved anomalies are *promoted into new golden cases* — closing the 3× recurrence loop.

**The three epics and their dependency order.** Two enablers come first: the shared engine package and the golden/anomaly storage. The detector and the port both consume them.

```
        ┌─────────────────────────────────────────────────────────────┐
        │ EPIC A — Shared engine + golden/anomaly infra (ENABLERS)      │
        │  A0  Extract @cap-flow/ucb (kills 458-line classifier drift)  │
        │  A1  golden_cases + anomaly_flags schema (multi-tenant)       │
        │  A2  replayPositions() pure harness + fixture loader          │
        │  A3  Golden API + fixture export + seed the known incidents   │
        └───────────────┬───────────────────────────────┬─────────────┘
                        │                                │
        ┌───────────────▼──────────────┐   ┌─────────────▼──────────────┐
        │ EPIC B — Server-side UCB port │   │ EPIC C — Anomaly detector   │
        │  needs A0 (engine) + A1       │   │  needs A1 (anomaly_flags),  │
        │  B1 op pricing cache          │   │  A3 (golden_cases for B2)   │
        │  B2 CEX adapter               │   │  C1–C6 pre-port checks +    │
        │  B3 V3 enrichment             │   │       SQL report            │
        │  B4 receipt-token transfers   │   │  C7–C8 post-port checks     │
        │  B5 server ucb.service shadow │◄──┤       gated on B5 landing   │
        │  B6 UI flip (flagged)         │   │  C9 admin audit page        │
        └───────────────────────────────┘   └─────────────────────────────┘
```

- **A0 is a hard prerequisite for all of B** (single source of truth; one ordering of overrides shared by client and server).
- **A1 is a hard prerequisite for C3+ and B5** (the `anomaly_flags` / `golden_cases` / `ucb_shadow_results` tables).
- **C7–C8 (post-port detector checks) are gated on B5 landing** (they read canonical server values) behind the `UCB_PORTED` flag.
- B1–B4 are independent of each other and may land in parallel after A0.

**Schema-naming decision.** Canonical names: `golden_cases` and `anomaly_flags`. There is exactly one of each table.

**Multi-tenancy model (applies to every new table below).**
- **User-scoped, row-level isolation** (carry `wallet_id` and/or `account_id`, queried only with a wallet/account predicate, FK `ON DELETE CASCADE`): `golden_cases`, `anomaly_flags`, `ucb_shadow_results`. These describe a *specific user's* wallet/position.
- **Shared, no-`user_id` reference tables** (objective on-chain/market facts, immutable, read by all users): `op_token_prices`, `v3_liquidity_events`, `v3_position_snapshots`, `receipt_token_transfers`. Keyed by `(chain, …, time/block)`. Writes are `onConflictDoNothing` (immutable facts) and **must never persist a row when the upstream price lookup failed/returned 0** (risk R5).
- The **committed fixtures** that golden cases generate carry no PII (ops + frozen prices + expected numbers) and are checked into the repo so regression tests run offline for everyone.

---

## EPIC A — Shared engine + golden/anomaly infrastructure (enablers)

### Stage A0 — Extract the engine into `@cap-flow/ucb` (do NOT copy)

> ⚠️ **CORRECTION (2026-05-30, from live code inspection — supersedes the original premise below).** The original A0 premise ("extract one shared engine, unify the helpers, delete server drift, zero behavior change") is **WRONG and unsafe**, and the planning-agent's R3 example was backwards:
> - `normalizeSymbol` is defined **9 times across web** with **intentionally different semantics**: `lot_tracker`/`open_positions`/`position_lot_cost_basis`/`closed_positions` = WETH→ETH only; `cost_basis_tracker` = WETH→ETH + generic w-prefix strip (wstETH-protected); `v3_cost_basis_override` = WETH→ETH **+ WBTC/TBTC/CBBTC→BTC**. V3 aliases wrapped-BTC on purpose; the lot tracker must NOT (it would merge BTC/WBTC lots — D4 handles that at the pool level).
> - `wrapped_symbols.ts` carries an explicit author warning: *"Не делать общий нормализатор … расширение этой map'ой может изменить группировку lots."* Unifying the helpers would **change cost basis**, i.e. break the very thing we must not break.
> - The server's `protocols.ts`/`token_roles.ts`/`junk_filter.ts` are not simply "smaller drift" — the API consolidated content (EUR_STABLES, full normalizeSymbol, receipt patterns) that web splits across files; a naive "adopt web, delete server copy" would DELETE richer server logic and break classification.
> **Revised approach:** (1) build the A2 golden-replay harness FIRST as the behavioral safety net — no engine extraction without it; (2) when extracting, move WHOLE modules preserving each one's private helpers verbatim (do NOT collapse the 9 normalizeSymbols); (3) acceptance is BEHAVIORAL (server replay == client replay on goldens), NOT a constant-table deep-equal. The `drift_guard.test.ts` idea is dropped. See revised ordering: A2 → A1 → A0(surgical) → A3.

> **A0 SURGICAL — incremental slice progress (2026-05-30):**
> - ✅ **A0.1 — package scaffold + pure type/constant base.** Created `packages/ucb` (`@cap-flow/ucb`, dist-based like `@cap-flow/db`, wildcard `./*` subpath exports). MOVED verbatim (zero-import pure leaves): `types.ts`, `token_roles.ts`, `wrapped_symbols.ts` → `packages/ucb/src/`. Web consumes via `"@cap-flow/ucb": "workspace:*"` + per-module **re-export shims** at the old `@/lib/portfolio/...` paths (import sites unchanged). Verified: ucb build clean, web `tsc` 0 errors (incl. types.ts's 89 importers), **full web suite 557/557 green**, **`vite build` succeeds**. Zero behaviour change. Pattern proven (dist + workspace symlink + Bundler-resolution of `exports`).
> - ✅ **A0.2a — classifier foundation (keystone).** MOVED `protocols.ts` + `junk_filter.ts` → package. `protocols.ts` was NOT a clean leaf (imported `@/lib/defillama_protocols`, a fetch/localStorage catalog client) → broke that dep with an **injected catalog oracle** (`registerProtocolCatalogOracle`), mirroring the codebase's existing `registerReceiptLessOracle` pattern; web wires it in `main.tsx` via `getProtocolMetadataSync` + `mapDefiLlamaToProtocolCategory`. Behaviour preserved: tests have no catalog (empty snapshot → "other", as before); web app registers the oracle. Verified: ucb build, web `tsc` 0, **557/557 tests** (incl. `protocols.test.ts` ×52), `vite build` ✓. This unblocks the engine core (cross_protocol → protocols).
> - ✅ **A0.2b-i — pricing helpers + lot-tracker core.** MOVED: `@/lib/defillama` PURE helpers (`defillamaCoinKey`, `priceFromMap`, `priceFromMapNearest`) + the shared key format (`bucketTs`, `cacheKeyFor`, `NATIVE_COIN`, `CHAIN_TO_LLAMA`) → `packages/ucb/src/pricing.ts`. web `defillama.ts` rewritten to keep ONLY the fetch/localStorage client (`fetchHistoricalPrices`, `fetchOneTs`, cache) and import+re-export the pure helpers (single source for the load-bearing `{coin}|{bucketTs}` key format — no drift). Then `lots/{types,lot_tracker,compat,edge_cases}.ts` → `packages/ucb/src/lots/` (the cost-basis lot tracker core; `lot_tracker`'s private WETH→ETH-only `normalizeSymbol` preserved verbatim). `.js` extensions added on relative imports (NodeNext). Web re-export shims at all old paths; `lots/index.ts` stays in web (still re-exports the not-yet-moved `build`/`self_check`). Package now 10 modules. Verified: ucb build, web `tsc` 0, **557/557 tests**, `vite build` ✓. Zero behaviour change.
> - ✅ **A0.2b-ii — UCB pipeline core (12 files).** MOVED: `positions/{types,position_tracker,cross_protocol,build}`, `lots/{build,cross_wallet_cost_basis,fiat_hop_cost_basis}`, `cost_basis_tracker`, `position_lot_cost_basis`, `realized_pnl`, `apply_annotations`, `ucb_pipeline` → package. `@/lib/defillama`→`./pricing.js`/`../pricing.js`; `@/features/chain-ops/api` `ResolvedAnnotation` → new `packages/ucb/src/annotations.ts` (standalone interface, structurally matches web's `z.infer`). `.js` extensions added to all relative imports (perl). Web re-export shims at all old paths. Verified: ucb build clean, **557/557 tests**, `vite build` ✓.
>   - **DEFERRED (blocked):** `position_coverage` (→ `purchase_history`, not yet moved), `lending_cost_basis_override` + `cex_inheritance_cost_basis_override` (→ `open_positions` + `actual_supplied_tokens`, A0.3). `positions/verify` + `lots/self_check` stay in web ([window] dev asserts). `lots/index.ts` stays in web (re-exports moved siblings + the not-yet-moved `build`... now `build` IS moved, but `self_check` isn't).
>   - **🔑 MAJOR FINDING — web `tsc` was never a real gate.** `apps/web` ships via Vite (esbuild, NO typecheck) and its `tsc --noEmit -p tsconfig.json` is a **no-op references project**. The real check `tsc -p tsconfig.app.json` reveals **~275 pre-existing latent type errors** (e.g. `exactOptionalPropertyTypes` violations, `consumedAt` required-but-omitted, `as ClassifiedOp` casts in tests). My earlier "web tsc 0 errors" reports were FALSE-GREEN. **Real web gates = `vitest` + `vite build`** (both green throughout). The package's `tsc` build is the FIRST strict enforcement this engine code has ever seen.
>   - **Decisions to keep moves verbatim:** (a) package `tsconfig` sets `exactOptionalPropertyTypes: false` — the moved code was never written against it; all other strict flags stay ON. (b) `ConsumeOptions.consumedAt` relaxed to optional (call sites in `position_lot_cost_basis` legitimately omit it → `consumes[].time` undefined, preserved via `as number`). (c) package `ResolvedAnnotation.excluded?: boolean | undefined` (explicit undefined) for assignability from web under its exactOptional. Net web `tsc` effect: 276→275 (one fewer; zero added).
> - ✅ **A0.3 — entangled tail (DONE).** MOVED: `live`, `actual_supplied_tokens`, `purchase_history`, `position_coverage`, `open_positions` (208KB), `lending_cost_basis_override`, `cex_inheritance_cost_basis_override` → package. New package modules: `wallet.ts` (`WalletChain`/`SavedWallet`, web `lib/wallets.ts` re-exports + keeps its store), `supply_hash.ts` (`supplyAmountsHash`, web `position_overrides.ts` re-exports). `readPipelineSettings` turned out to be a **dead import** in open_positions → dropped (no settings injection needed). `@/lib/defillama`→`./pricing`, `@/lib/wallets`→`./wallet`, `position_overrides`→`./supply_hash`, all relative imports → `.js`.
>   - **Strict-typecheck surfacing (the package is the first real `tsc` this code ever saw):** 55→0 errors resolved. tsconfig: `lib: [ES2022, DOM, DOM.Iterable]` + `types: [node]` (isomorphic — `typeof window` + `process.env` guards), `noUnusedLocals/Parameters: false`, `exactOptionalPropertyTypes: false`. **Genuine latent type-holes fixed additively (zero behaviour change):** `OpenPosition.netPnlUsd?/netPnlPct?` (computed fields the code sets), `LivePositionTokenLine.isStable?`, v3MintPoolPrices `.blockNumber?` (diagnostics), `feesClaimedHistory: []` on inferred positions (was undefined, never read there), 2× `as ProtocolCategory` (string→union), `import("./lots")`→`./lots/lot_tracker.js`.
>   - **Verified:** ucb build 0 errors (33 modules), **web vitest 557/557**, `vite build` ✓, A2 golden replay green THROUGH the package engine (startUsd=$2000 preserved). Bonus: web `tsc -p tsconfig.app.json` baseline **275→233** (the additive type fixes also cleared ~42 pre-existing web errors at call sites).
>
> ### ✅ A0 COMPLETE (client-side extraction) — 2026-05-30
> The shared `@cap-flow/ucb` package now owns the full UCB engine (lot tracker, cross_protocol position builder, ucb_pipeline, open_positions, classifier heuristics, pricing helpers, lending + CEX overrides, annotation/wallet/supply types). `apps/web` consumes it entirely via re-export shims — **zero import-site churn, zero behaviour change** (557 tests + golden replay green throughout). The 9 intentionally-different `normalizeSymbol` copies were preserved verbatim (never unified).
> **Still deferred (by design, NOT part of A0):** `v3_cost_basis_override` + V3 enrichment → **B3**; web-only/UI-adjacent files (`tax_*`, `asset_*`, `closed_positions`, `position_provenance`, `self_check`/`verify` [window]) stay in web; **server deletes its drifted `apps/api/.../classifier/*` copies and imports from `@cap-flow/ucb` → Epic B** (changes server behaviour, gated by B5 shadow-diff).
> - ⏳ **A0.3 — entangled tail:** `protocols.ts` (needs the `@/lib/defillama_protocols` catalog resolver INJECTED — it's a fetch/localStorage web module, can't be imported by the package) → unblocks `junk_filter`; `open_positions.ts` (Tier-2: inject `pipelineSettings` instead of `readPipelineSettings()`; move `supplyAmountsHash` to a pure module). `v3_cost_basis_override` stays in web until B3.
> - **Server reconciliation (delete `apps/api/.../classifier/*` drifted copies, import from `@cap-flow/ucb`) is DEFERRED to Epic B** — that step changes server behaviour and must be shadow-diff-validated (B5), not done blind here.

*(Original premise, retained for history — do not act on it:)* The classifier was previously ported by *copy* and `apps/api/.../classifier/protocols.ts` now differs from `apps/web/.../portfolio/protocols.ts` by ~400 lines. We extract once into a shared package and delete the drifted server copies.

#### A0 engine-extraction map (2026-05-30, from purity + import-graph scan)

Purity scan of `apps/web/src/lib/portfolio/**` (markers: R=react/hook, F=fetch, L=localStorage, W=window, M=import.meta) + import-graph of the impure edges. The engine CORE is pure; entanglement is narrow and identified:

- **Settings leak into `open_positions.ts`:** imports `readPipelineSettings` (localStorage; SSR-safe but returns DEFAULT server-side → would silently diverge from the user's choice — must be **injected as a param**, not defaulted) and `supplyAmountsHash` (actually a PURE fn living in the localStorage-backed `position_overrides.ts` → move to a pure module).
- **`@/lib/defillama` [FL]:** engine uses only the 3 PURE helpers `defillamaCoinKey` / `priceFromMap` / `priceFromMapNearest` → extract those into the package; the fetch/localStorage client stays in web.
- **`@/lib/v3` [R/L]:** `v3_cost_basis_override.ts` depends on `v3/hook.ts` (React) + `v3/liquidity_events.ts` (localStorage) → its extraction is **deferred to B3** (server V3 enrichment), NOT early A0.
- **Type-only cross-imports** (`SavedWallet`, `ResolvedAnnotation`, `V3Position`/`V3PositionMap`): trivially handled (move/duplicate the type).
- **Barrel leak:** `lots/index.ts` re-exports `self_check` (window) → split the dev self-check out of the barrel.

**Extraction tiers:**
| Tier | Modules | Risk | When |
|---|---|---|---|
| **1 — clean core** | `lots/*` (self_check out of barrel), `positions/*`, `classifier`, `protocols`, `token_roles`, `junk_filter`, `wrapped_symbols`, `types`, `apply_annotations`, `ucb_pipeline`, `cost_basis_tracker`, `cost_basis_avg`, `position_lot_cost_basis`, `position_coverage`, `realized_pnl`, `v3_dedupe_matched`, `v3_claimed_fees_split`, `deposit_seeds`, `internal_transfers`, `async_deposit_linker`, `purchase_history`, `actual_supplied_tokens` + the 3 pure defillama helpers | low (pure, intra-deps only) | A0 |
| **2 — inject settings** | `open_positions.ts`: take `pipelineSettings` as a param instead of `readPipelineSettings()`; move `supplyAmountsHash` to a pure module | medium (signature refactor) | A0, after Tier 1 |
| **3 — deferred** | `v3_cost_basis_override.ts` (entangled with `@/lib/v3` React/localStorage) | — | B3 |
| **stays in web** | `use_computed_positions`, `use_hist_prices`, `use_bridge_detection`, `feature_flags`, `pipeline_settings`, `position_overrides` (localStorage part), `credit_overrides`, `column_prefs`, `manual_annotations`, `asset_composition`, `self_check`, `positions/verify`, `position_provenance` | — orchestration/settings | — |

**Crucial preserve-rule:** the 9 intentionally-different `normalizeSymbol` copies must move WITH their owning module, each keeping its own private copy — do NOT unify (see correction above). The shared package preserves divergence; it does not erase it.

**Sub-tasks**
- Create `packages/ucb` (`"@cap-flow/ucb"`, `"type":"module"`, `workspace:*`, built with `tsc` like `@cap-flow/db`).
- **Move** (not copy) the verified-pure modules: `lots/` (tracker + `build.ts` + types), `positions/` (`cross_protocol.ts`, `position_tracker.ts`, `build.ts`, `types.ts`), `apply_annotations.ts`, `realized_pnl.ts`, `ucb_pipeline.ts`, `types.ts`, `protocols.ts`, `token_roles.ts`, `junk_filter.ts`, `wrapped_symbols.ts`, and the three overrides + deps (`v3_cost_basis_override.ts`, `lending_cost_basis_override.ts`, `cex_inheritance_cost_basis_override.ts`, `position_coverage.ts`, `v3_dedupe_matched.ts`, `v3_claimed_fees_split.ts`).
- Extract the **pure** pricing helpers (`defillamaCoinKey`, `priceFromMap`, `priceFromMapNearest`, `isStableSymbol`) and the **canonical-symbol map** (`normalizeSymbol`: WETH→ETH **and** WBTC/TBTC/CBBTC→BTC — the full client version, not the server's partial WETH-only one, risk R3) into `@cap-flow/ucb/pricing`.
- Encode the override **ordering** (the `useComputedPositions` lines 299–500 sequence: V3 → lending → CEX → V3 claimed-fees split → krystal dedup → closed-dust filter → non-LP opener) as a single `applyAllOverrides()` in the package, so client and server share even the order, the float accumulation order, and the `DISTANCE_TOLERANCE = 0.01` constant (risk R4).
- Web re-exports from `@cap-flow/ucb` via a thin barrel (or tsconfig path alias) so existing `@/lib/portfolio/...` import sites keep working. **Server deletes its drifted `classifier/{protocols,token_roles,junk_filter,types}.ts` copies** and imports from `@cap-flow/ucb`.

**✅ Test (local).**
- `pnpm --filter @cap-flow/ucb test` runs the moved unit tests unchanged (`ucb_pipeline.test.ts`, `cost_basis_invariant.fuzz.test.ts`, `artur_flow.integration.test.ts`, `*.borrow.test.ts`) — green = behavior preserved.
- New `packages/ucb/test/drift_guard.test.ts`: deep-equal the `protocols`/`token_roles` constant tables imported from `@cap-flow/ucb` vs the old server path. **Fails today (458-line drift); passes once the server consumes the shared source** — this is the acceptance gate.
- `pnpm -r typecheck && pnpm -r test && pnpm --filter web build` green; `bob@example.com` `/positions` renders byte-identical numbers in the dev server (pure refactor, zero behavior change).

**🚀 Promote to prod.** Gate: CI green (no flag — it is a pure refactor with no runtime-path change). Deploy; spot-check one prod account's `/positions` against a pre-merge screenshot. **Migration:** none (code-only).

---

### Stage A1 — `golden_cases` + `anomaly_flags` schema (user-scoped, row-level isolation)

> ✅ **DONE (2026-05-30).** Files: `packages/db/src/schema/golden_cases.ts` (22 cols, user-scoped via `walletId`), `anomaly_flags.ts` (21 cols, user-scoped via `accountId` + nullable `walletId`), exported from `schema/index.ts`; migration `drizzle/0025_golden_anomaly.sql` (additive, two tables). `@cap-flow/db` build clean. Applied to local dev DB; verified: golden isolation (W1 row invisible to W2-scoped query), position-level duplicate rejected by `anomaly_flags_idem_uq`, account-level NULLS-NOT-DISTINCT dedupe rejected. Test rows cleaned up.
> - **DEVIATION from plan (deliberate):** idempotency key is `(account_id, wallet_id, position_id, check_id)` NULLS NOT DISTINCT — NOT the plan's `(account_id, wallet_id, check_id)`, which would collapse distinct positions in one wallet that trip the same check. Documented in the schema file.
> - **Circular-FK avoidance:** `golden_cases.promoted_from_anomaly_id` is a soft link (no FK); `anomaly_flags.golden_case_id` keeps its FK (ON DELETE SET NULL). golden_cases created first in the migration.
> - **⚠️ PRE-EXISTING dev-DB finding (not from this change):** `public.__migrations` is recorded only through 0016, but tables 0017–0024 physically exist (applied via `drizzle-kit push` or a reset). So `pnpm db:migrate` currently FAILS on the dev DB at 0017 ("already exists"). I applied 0025 directly via psql and registered it. **This will bite CI/prod deploy** (migrate-first gate) — the `__migrations` table needs back-filling with 0017–0024 before `pnpm db:migrate` works cleanly. Flagged for a separate fix.

Both tables are **user-scoped** (carry `wallet_id`/`account_id`). A golden case is a *per-position expected output* oracle (frozen, versioned); an anomaly flag is a *per-position-per-rule* detector finding (mutable lifecycle). They are deliberately **separate from `chain_operation_annotations`** (which is per-op, per-user, mutable *input* into the pipeline) — conflating "what the user forced" with "what we proved correct" is exactly the anti-pattern the annotations file warns about.

**Sub-tasks**
- `packages/db/src/schema/golden_cases.ts` — user-scoped via `walletId` (FK `wallets.id ON DELETE cascade`). Columns:
  - identity/anchor: `positionId` (= `OpenPosition.id`), `chain`, `protocolId`, `marketKey` (durable on-chain anchor: V3/Velodrome NFT tokenId, lending receipt-token addr, null for CEX), `openHash`, `label` (e.g. `"POS-011"`).
  - oracle: `expectedStartUsd`, `expectedNetStartUsd`, `expectedPnlUsd` (nullable, snapshot-time), `toleranceAbsUsd` (default `1`), `tolerancePct` (default `0.02`). Pass = within **abs OR pct** (whichever is looser).
  - provenance: `sourceOfTruth` (`etherscan_v2|krystal|revert_ui|manual`), `provenanceNote`, `methodologyVersion`.
  - fixture linkage: `fixturePath`; lifecycle: `status` (`active|retired`), `createdByUserId`, `promotedFromAnomalyId` (learning-loop link), `createdAt`, `updatedAt`.
  - indexes: `uniqueIndex(walletId, positionId)`, `index(walletId)`, `index(chain, marketKey)`, `index(label)`.
- `packages/db/src/schema/anomaly_flags.ts` — user-scoped via `accountId` (FK) + nullable `walletId`. Columns: `positionId`, `chain`, `protocolId`, `marketKey`, `checkId`, `anomalyType`, `severity` (`info|warn|error`), `phase` (`pre|post`), `observedValue`, `expectedValue` (null if no golden yet), `detail` (jsonb), `goldenCaseId` (nullable FK `golden_cases.id ON DELETE set null`), `status` (`open|acknowledged|resolved|promoted`), `detectorVersion`, `resolvedNote`, `firstSeenAt`, `lastSeenAt`, `resolvedAt`.
  - **Idempotency key:** `uniqueIndex(accountId, walletId, checkId)`. Plus `index(status)`, `index(walletId)`.
- Export both from `packages/db/src/schema/index.ts`. Add forward-only migration `0025_golden_anomaly.sql` — **additive only**, reversible by backup not down-script (risk R11).

**✅ Test (local).** Build `@cap-flow/db`; `pnpm db:migrate` against local dockerized Postgres; confirm both tables exist; insert a dummy `anomaly_flags` row twice → unique constraint rejects the duplicate; insert a `golden_cases` row for bob → cross-user select returns empty (isolation).

**🚀 Promote to prod.** Gate: migration applied on prod DB **before** any code that reads the tables; CI green. **Migration:** `0025` additive.

---

### Stage A2 — `replayPositions()` pure harness + fixture loader

> ✅ **DONE (2026-05-30).** Built in web (no extraction), fully offline. Files: `apps/web/src/lib/portfolio/replay/replay_positions.ts` (hook-free harness: runUcbPipelineForWallet → buildOpenPositions → lending → CEX overrides; V3/Krystal/non-LP deferred to B3/B4, guarded no-ops when absent), `replay/golden_fixture.ts` (fixture type + `fixtureToReplayInput` loader + `matchesAnchor`/`findGoldenPosition`/`withinTolerance`), `__fixtures__/golden/simple-aave-eth.json` (first anchor: 1 WETH bought $2000 → Aave → now $3000; asserts startUsd=$2000 cost basis, not $3000 spot, no fallback), `replay/replay_positions.test.ts`. Result: 6/6 new tests pass, full portfolio suite 385/385 green, `tsc` 0 errors. The behavioural safety net for A0 is now live. Note: status literal is `"ok"` (not `"success"` — existing tests hide this via `as` casts).

The lot/position tests already replay raw `ClassifiedOp[]` with zero external calls. We refactor the override chain into a hook-free callable fed frozen inputs, so the canonical pipeline runs offline.

**Sub-tasks**
- In `@cap-flow/ucb`, expose `replayPositions(input)` — a thin wrapper calling `buildOpenPositions` + `applyAllOverrides()`, fed `input.historicalPrices` / `input.v3LiquidityEvents` / `input.cexCostBasisByHash` / `input.annotations` instead of React hooks. No Alchemy/Etherscan/DefiLlama calls.
- Fixture format `apps/web/src/lib/portfolio/__fixtures__/golden/<label>.json`: `{ schemaVersion, label, methodologyVersion, position{id,chain,protocolId,marketKey,openHash}, input{ops[], annotations[], historicalPrices[], v3LiquidityEvents[], lotMethodology}, expected{startUsd,netStartUsd,pnlUsd,toleranceAbsUsd,tolerancePct}, provenance{sourceOfTruth,note} }`.
- Fixture loader + `matchesAnchor(position, fixture.position)` matching on the durable anchor (marketKey/openHash), so cases survive `positionId` format tweaks.

**✅ Test (local).** Feed one hand-built fixture and assert `replayPositions` reproduces a known `startUsd`; run `pnpm --filter web test` **with the network blocked** to prove fully offline. Include the C11 fully-consumed-lot fixture (assert `wacAt` reconstructs amount-at-time via `lot.consumes`, no market-price fallback, risk R12) and a `status==="failed"` op contributes $0 (risk R13).

**🚀 Promote to prod.** Gate: CI green. **Migration:** none.

---

### Stage A3 — Golden API + fixture export + seed the known incidents

**Sub-tasks**
- Controllers — **ALL behind the admin role guard** (Q6: golden/anomaly are admin-only; no user-facing surface; `walletId`/`accountId` = curated subject, not editable owner). Note: API framework is **Fastify**, not NestJS (root README; the planning agent said NestJS — verify the actual guard/route idiom in `apps/api` before coding A3):
  - `POST /golden-cases` → 201, serializes the current input set (ops + the frozen prices/events the overrides consumed) into `__fixtures__/golden/<label>.json`; commits the path to `golden_cases.fixturePath`.
  - `GET /golden-cases?walletId=`, `PATCH /golden-cases/:id`, `DELETE /golden-cases/:id` (soft-retire).
  - `GET /anomalies?status=open&walletId=`, `PATCH /anomalies/:id` (ack/resolve + note), `POST /anomalies/:id/promote` → creates a `golden_cases` row carrying provenance, sets `anomaly.status='promoted'` + bidirectional `goldenCaseId` / `promotedFromAnomalyId`.
- `golden_cases.replay.test.ts` harness iterating `loadGoldenFixtures()` → `replayPositions` → assert within tolerance.
- **Seed the known incidents as golden fixtures + `status='active'` rows** (each must first go *red* against today's broken pipeline to prove it is a real anchor):

| Label | Anchor | expectedStartUsd | sourceOfTruth |
|---|---|---|---|
| **POS-011** | Velodrome gauge-staked CL NFT `3427422` (optimism) | **$237.80** (not prod $20.40, not local $0) | etherscan_v2 + live ownerOf(gauge) recon |
| **V3 EUR-stable** | V3 LP with EUR-stable leg | computed with EUR/USD ≠ 1 | defillama |
| **WBTC/BTC aliasing** | D4 canonical pool spanning `WBTC`/`BTC` | single WAC start across alias | manual |
| **C11 wacAt** | fully-consumed-lot position | start via `lot.consumes`, no market fallback | manual |
| **POS-007/008** | GMX V2 GM position | start = real entry, NOT `currentUsd` | etherscan_v2 |
| **POS-024 guard** | V3 NFT needing external enrichment | known-good value; replay completes (no unbounded calls) | etherscan_v2 |

**✅ Test (local).** API up locally: `POST /golden-cases` for bob, assert fixture file written and picked up green by `golden_cases.replay.test.ts`; `GET` returns it; cross-user `GET` empty. POS-011 replay goes red against today's pipeline (proves anchor). **POS-011 must preserve the gauge-emissions-vs-fees guard** (risk R14).

> **A3 — incremental progress (2026-05-30):**
> - ✅ **A3.1 — server golden/anomaly admin API.** New module `apps/api/src/modules/golden/` (`golden.repository.ts`, `golden.service.ts`, `golden.routes.ts`), all behind `app.requireAdmin` (Q6). Endpoints under prefix `/v1/admin/golden`: `POST/GET/PATCH/DELETE /cases`, `GET/PATCH /anomalies`, `POST /anomalies/:id/promote` (learning loop, transactional, bidirectional link). Numeric↔number at the wire boundary (mirrors annotations). Wired in `app.ts`. Note: the API is **DB-only — it does NOT write repo files**, so the committed fixtures are produced dev-side (A3.2 / export tooling), not by the server; golden_cases stores the oracle (anchor + expected + provenance) which is all the detector needs. Verified: api `tsc` 0 errors; **DB smoke** (`src/scripts/golden-smoke.ts`) green — createGolden (numeric round-trips 237.8), list, patch/retire, promote-transaction with bidirectional link, cleanup.
> - ✅ **A3.2 — auto-glob golden replay.** `replay_positions.test.ts` now `import.meta.glob`s `__fixtures__/golden/*.json` → every committed/seeded fixture is regression-tested automatically. 6/6 green; full web suite 557/557.
> - ✅ **A3.3 (UI built; live click-through pending a run of our stack).** Admin "★ mark golden" affordance added to the open-positions LIST (`OpenPositionsPage.tsx` — button in the `protocol` cell, admin-only via `useAuth().isAdmin`, passed through `PositionRow`). New: `features/admin/golden/{api,hooks}.ts` (typed client + react-query for `/v1/admin/golden/cases`), `components/admin/MarkGoldenDialog.tsx` — **two modes**: «✓ Эталон» (expected = current computed startUsd, frozen) and «✎ Неверно» (admin enters the CORRECT startUsd → drift shown until engine fixed). Both POST a `golden_cases` row with anchor (walletId/positionId/chain/protocolId/marketKey=lpTokenId/openHash) + expected + sourceOfTruth + derivation note. Verified: `vite build` ✓, **557/557 tests**, **0 new type errors** (web `tsc` baseline stays 233). Test account `testakk` confirmed in DB: 4 wallets synced (mmaksimuk, mmaksimuk-дочери, Rabby-artur 0x3df3…, Murat), 1211 ops — the incident addresses.
> - ✅ **A3.4 — live click-through VERIFIED end-to-end (2026-05-30).** Ran OUR stack (api+web from `condescending-fermi`) against the shared dev DB, logged in as admin `egorov` (who was already impersonating `testakk` in view-mode), opened testakk's open-positions list, clicked ★ on POS-001 (Krystal), saved as «Эталон» → **golden_cases row created** (label POS-001, arb_krystal, expected_start_usd=1.173933, source manual, status active, created_by = egorov the admin). HTTP 200.
>   - **🔑 AUTH-MODEL GAP found + fixed:** golden marking happens while an admin IMPERSONATES a user (the only way to see that user's client-computed positions), but impersonation sets `req.user.role` = the TARGET's role (`user`) → plain `requireAdmin` 403s, and web `isAdmin` (`role==admin && !impersonation`) hid the button. Fix: new `requireAdminOrImpersonator` decorator (allows if role==admin OR the impersonator is verified-admin); golden routes use it; route records the IMPERSONATOR as actor (`actorOf`). Web gating → `isAdmin || isImpersonating` (survives reload; server verifies). 
>   - **2 bugs found via the live test:** (a) frontend `position.walletId` is a COMPOSITE id (`api:<uuid>:<addr>`) — extract the UUID for the FK (was 400); (b) `validateExpected(input)` iterated `Object.entries` of the WHOLE body and `!Number.isFinite("0x…")` threw on string fields → 404; fixed with a `typeof v === "number"` guard. Both fixed, re-verified 200.
>   - Verified: api `tsc` 0, web **557/557**, `vite build` ✓.
>   - NOTE: the POS-001 ($1.17) golden is a smoke artifact — retire it via the UI; real seeding (POS-011 $237.80 etc.) is the curation step now unblocked.
> - ✅ **A3.5a — marking UX iteration (from live testakk feedback, 2026-05-31).** Migration 0026 added `golden_cases.kind` ('golden'|'wrong') + `issue` (which metric). Fixes/features: **(#5) upsert** on (wallet_id, position_id) — re-marking now 200 (was 500 dup-key), verified live. **(#1) row highlighting** — `/performance` fetches golden cases (admin-gated query) and tints rows green (golden) / amber (wrong) + colors the ★; verified POS-001/POS-002 GMX V2 show green. **(#3/#4) wrong-mode** — dialog now has an "issue" dropdown (startUsd / current value / fees / APR / PnL / other), expected value OPTIONAL (flag-only when the right number is unknown), sourceOfTruth options labeled. Verified: api `tsc` 0, web **557/557**, `vite build` ✓.
> - ✅ **A3.5b — positions-empty-until-refresh FIXED (2026-05-31).** Root cause: `LoadedWalletsProvider` bootstrap server-hydrates ONLY `ops` (cheap, no DeBank credits) and `continue`s without `load()` → `live` (DeBank state, needed by `buildOpenPositions`) is absent → positions empty until manual «Обновить». Worse, `writeWalletCache(fromServer)` CLOBBERED any previously-cached `live`. Fix: `tryHydrateFromServer` now preserves the previously-cached `live` from localStorage (`readWalletCache(...).live`) → positions paint INSTANTLY from cache with ZERO extra DeBank calls; a real `load()`/hourly tick still overwrites it with fresh state. Respects the credit-saving design (no auto-DeBank-on-mount). Verified: reload `/performance` renders 6 positions immediately without clicking «Обновить». First-EVER visit (no cached live anywhere) still needs one refresh — true zero-touch first load would require hydrating `live` from the server's `portfolio_snapshots` (worker-written), a later option. web `tsc` baseline 233 (0 new), `vite build` ✓. (#4-extended) for non-startUsd issues (fees/APR), the golden_cases row currently only stores the issue label + note — no per-metric expected value; revisit if needed. Plus the real incident seeding (POS-011 etc.).
> - ⚙️ **A3.6a — derivation capture BUILT + 2 blockers found (2026-05-31).** Migration 0027 (`golden_cases.derivation` jsonb) + `@cap-flow/ucb/derivation.ts` `buildPositionDerivation(position, ops)` (extracts acquisitions/supplies + cost from ops) + server stores it + dialog auto-builds & sends it (manual `sourceOfTruth`/`expected` dropped → source is always "chain_ops"). **Pipeline verified end-to-end** (marked a position live → derivation jsonb stored, 200). BUT two real blockers surfaced via live test — must fix before this is useful:
>   1. **🔴 positionId INSTABILITY (critical).** `POS-NNN` ids reshuffle on every recompute/refresh (observed: WBTC-Fluid went POS-017→POS-013, Morpho POS-020→POS-016; and after a refresh the first-row "POS-001" became a DIFFERENT wallet's $200 GMX position). So golden identity/highlight keyed on `(walletId, positionId)` ATTACHES MARKS TO THE WRONG POSITION after recompute. **Fix:** key + match golden by the DURABLE anchor (`walletId` + `chain` + `protocolId` + `marketKey`), NOT positionId. (The plan's `matchesAnchor` already intended this; the impl regressed to positionId.) This corrupts the golden base until fixed.
>   2. **🟠 derivation CONTENT weak for complex positions.** The heuristic symbol-match (`buildPositionDerivation`) gave empty acquisitions/supplies for a GMX V2 GM position (GM is decomposed into WBTC/USDC supply-tokens, but the deposit is an async USDC→GM lp_add — symbol-match misses it). Confirms the earlier honest point: exact derivation for complex/async positions must come from the **engine's lot-consumption trace** (`position_lot_cost_basis`/`lot_tracker` emit which lots/ops were consumed), not a heuristic. Clean cases (WBTC swaps) work; async-deposit/decomposed need the engine trace.
> - ✅ **A3.6b — BOTH blockers fixed (2026-05-31).** **(1) positionId instability** → introduced `@cap-flow/ucb/identity.ts` `positionKey(p)` = `realWalletId|chain|protocolId|marketKey||openHash|sortedSupplySymbols`; `golden_cases.positionKey` column (mig 0028, unique partial index) + upsert on it; highlight/match keyed by `positionKey`, not `POS-NNN`. **(2) derivation content** → `buildPositionDerivation` now takes an optional `DerivationEngineContext {histPrices, costBasisOverrideByHash, methodology}` and, per non-stable supplied token, replays `getPositionLotCostBasis` (same args as the production startUsd path: `useNetSuppliedAmount:true` + merged overrides) to emit the REAL `tokenTraces[]` — each consumed lot carries `sourceHash`/`symbol`/`chain` (extended `SuppliedLotConsumption`) so every lot links to the on-chain tx that created it; `opByHash` resolves each lot's `opType`/`opProtocol`. `engineTraced` flag = every non-stable token fully covered (uncovered ≤ 1e-9). `MarkGoldenDialog` shows a LIVE lot-trace preview (✓ выведено / ⚠ неполная провенанс) before saving; `OpenPositionsPage` passes `walletHistPrices.histPrices` + `costBasisOverrideByHash` + `lotMethodology`. schemaVersion bumped 1→2. Gates: ucb `tsc` 0, web vitest **557/557**, vite build ✓ (api tsc errors are pre-existing test-file baseline, unrelated). Heuristic acquisitions/supplies kept as human-readable context + server-side fallback.
> - ✅ **A3.6c — save 500 fixed + verified end-to-end (2026-05-31).** Saving golden returned **500** because the new `position_key` unique index (mig 0028) is **partial** (`WHERE position_key IS NOT NULL`), but the Drizzle `onConflictDoUpdate({target: positionKey})` lacked `targetWhere` → `ON CONFLICT (position_key)` didn't match the partial index → Postgres **42P10**. Fix: added `targetWhere: isNotNull(schema.goldenCases.positionKey)` in `golden.repository.ts`. Also pinned derivation methodology to **WAC** (was following the page's volatile Lot toggle) so the anchor deterministically reproduces the displayed startUsd. Verified live: POST→200, derivation jsonb has `engineTraced:true`/`schemaVersion:2`/WBTC lot←swap`0x71ca2a…`(1inch)/WAC/uncovered:0; **upsert idempotent** (replay same request ×2 → same id); DB has 3 golden rows (POS-001/002/003) each `rows_for_key=1`, no dupes. **Process lesson:** after editing `packages/ucb/src`, MUST `pnpm build` the package + restart web dev (Vite doesn't watch the symlinked workspace dist) — a stale dist caused a separate `tokenTraces undefined` crash first.
> - 📍 **RESUME POINTER (2026-05-31 EOD).** Сессия очень длинная — продолжать в НОВОЙ сессии (durable: этот план + `notes/golden/knowledge-base.md` + память). **Текущее состояние:** методология учёта выверена и зафиксирована (эталон=реестр; методика по активу; LP→Krystal точь-в-точь; partial-coverage→open-price; lot-toggle работает). Epic A практически закрыт. **B1.1-B1.4 DONE** (op_token_prices schema/migration 0029 applied + op-pricing.service/repository/test 6/6; остаток B1: worker-wiring + deep parity fixture). **Открытые баги (НЕ фикшены):** (1) **POS-005 GLV** — root cause локализован (KB §6b): `apply_opener_override.ts:106-117` перетирает верный buildOne $1300 на детекторный $1436.78; чинить `opener_detector.ts` (OUT-side для request/fill GLV). (2) **POS-004 wSPYx** — число верно, trace пуст (wSPYx↔SPYx aliasing). (3) movement.usd sync-time недетерминизм → лечит B1-wiring. **NEXT (по плану owner):** доделать B (фикс детектора GLV + B1-wiring), затем разметка остальных паттернов (staking/perp/EUR-stable/CEX-origin/gauge) + A3.2 fixture-export. Тест-аккаунт testakk, кошельки 1s/2s/3s (lex Bob). Все фиксы LOCAL-FIRST, НЕ коммичены (Q5).
> - 📍 **RESUME POINTER ОБНОВЛЁН (2026-05-31, СУПЕРСЕДИТ блок выше по двум багам).** Перепроверка по коду+тестам показала: пункты (1) POS-005 GLV и (2) POS-004 wSPYx из «открытых багов» **УЖЕ ИСПРАВЛЕНЫ и закоммичены в `1aa1b33`** — старый указатель устарел (написан ДО фикса). ⚠️ **Важно:** гипотеза старого указателя («$1436.78 = `startUsdFromStableOut`/`openedInTokens`») **НЕВЕРНА** — перепроверено on-chain (KB §6b): $1436.78 = `costBasisUnknown→currentUsd` в `apply_opener_override.ts`, НЕ детектор. **POS-005 факт. фикс:** `opener_detector.ts::collectAsyncRequestHashes()` (зеркало async_deposit_linker на сырых transfer'ах — добирает request-tx где 1300 USDC ушли в GlvVault ≠ lp-токен) → `openedInTokens=[USDC 1300]` → `startUsd=$1300` → `noOutSide=false` → ветка costBasisUnknown не срабатывает. Тесты `opener_detector.test.ts` (24, вкл. POS-005 real-data + 3 guard) + `apply_opener_override.test.ts` (26) + `cost_basis.test.ts` (12) = **62/62 green**. **POS-004 факт. фикс:** `packages/ucb/open_positions.ts` (collateralHint per-market scoping + `canonicalCollateralSymbol` wSPYx↔SPYx), тест `open_positions.morpho_multimarket.test.ts` **4/4 green**. ⚠ POS-004 вторичный путь (apply_opener_override re-pollution при shared singleton lpTokenId) — проверить live после рефреша (KB §6b хвост). **Остаётся открытым:** (3) movement.usd sync-time недетерминизм → B1-wiring. **NEXT (по плану owner):** B1-wiring (worker BullMQ job priceMapForOps+fillMissing, cache-fill only) + deep parity fixture; затем разметка остальных паттернов (staking/perp/EUR-stable/CEX-origin/gauge) + A3.2 fixture-export. KB §6b (uncommitted edit к knowledge-base.md) фиксирует root cause обоих. LOCAL-FIRST, не коммичено сверх 1aa1b33 (Q5).
> - ✅ **A3.2 — fixture-export path BUILT + Phase 1 (lending) DONE (2026-05-31).** Контекст: разметка A3.5 уже сделана (11 golden_cases в БД на testakk 1s/2s/3s, derivation захвачен). Не хватало инструмента экспорта (был только loader `fixtureToReplayInput`). **Сделано:** (1) `replayInputToFixture()` — инверсия loader'а (Maps→arrays), round-trip тест 3/3; (2) **dev-only хук** в `use_computed_positions.ts` (`window.__capflowGolden`, guard `import.meta.env.DEV`) публикует точный assembled ReplayInput (per-wallet ops+live, histPrices, costBasisOverrideByHash, lotMethodology, nonLpOpenerByKey, positions) — zero prod surface; (3) **multi-anchor формат** `GoldenFixture.anchors[]` (один wallet-capture → N assertions, backward-compatible), test-loop обновлён. **Capture-механизм:** chrome-devtools уже залогинен как testakk (view-mode admin), хук уже активен → собрал fixture в браузере, `Blob`+download (filePath песочница chrome-devtools запрещает запись в worktree) → `~/Downloads` → minify → `__fixtures__/golden/`. **Phase 1 fixture `testakk-1s-morpho-lending.json`** (wallet 1s, 233 ops + live, 172KB): POS-001 ($3481.31 PT-apyUSD, engineTraced=true ✓), POS-002 ($1405 PT-apxUSD, engineTraced=true ✓), POS-004 ($1084.09 SPYx). **⚠ Верификация по протоколу вскрыла:** POS-004 `engineTraced=false`/`fallbackUsd=1177.77`/`trace_count=0` — $1084 это **open/spot-fallback цена, НЕ lot-trace покупки** (SPYx acquired off-trace). Совпадает с прежней KB-пометкой (table:213 «engineTraced=false spot-fallback, число ок»). Owner уже подтвердил с этим caveat → оставил в фикстуре с честным маркером `caveat` + provenance-нотой (регресс-локает поведение, не выдаёт за traced cost basis). **Гейты:** replay 15/15, web vitest **591/591**. **NEXT:** Phase 2 (расширить harness замороженным `nonLpOpenerByKey` → GMX POS-005 $1300/POS-007 $1498.80 + Avantis POS-003 $1737.25); Phase 3 V3 (5 anchors) отложен до B3 (V3-override entangled с `@/lib/v3`). Follow-up: чистка derivation для async/decomposed (engineTraced=false на GLV/SPYx — A3.6a 🟠).
> - ✅ **A3.2 — Phase 3 (V3+Krystal) DONE (2026-06-01). Golden-регресс-цель закрыта по LP.** Захвачены + в оффлайн-регрессе **16 проверенных-vs-Krystal V3/V4/Pancake anchors** (`mmaksimuk-1.json` 10 + `mmaksimuk-2.json` 6). Harness воспроизводит startUsd через `applyV3CostBasisOverride` (slot0) + `applyKrystalV3Override` (authoritative LP). **Решено по ходу:** (a) covered-LP startUsd = Krystal, не slot0 → добавлен Krystal-override в harness; (b) **multi-NFT pool** (pool 0x641c00 = 3 NFT $501/$1726/$8149 в одном кошельке) → marketKey-якорь хватал не ту NFT → добавлен **match-type `tokenId`** (`GoldenAnchor.tokenId` + matchesAnchor) для disambiguation; (c) bigint-кодек для V3 (tokenId/liquidity). **POS-026 (Velodrome gauge) ИСКЛЮЧЕНА из replay** — slot0-матч gauge-CL не воспроизводится оффлайн (не Krystal-covered, нет override-коррекции); но **verified on-chain + документирована durable в KB §6c** (другой вид регресс-записи). Гейты: replay 77/77, web **658/658**. Builder `scripts/build-mmaksimuk-fixtures.mjs` (ANCHORS-список + tokenId). **Осталось по golden-цели:** POS-026 replay (нужен B3 — pure velodrome slot0 path), non-LP/lending re-capture (testakk-1s от удалённых кошельков всё ещё валидный frozen-регресс на тех ops). **Overall: LP golden-регресс закрыт; цель Golden-dataset ~90%.**
> - ⏳ **A3.2 — Phase 3 (V3+Krystal) первый CODE-COMPLETE (история, заменено выше).** **Ключевой урок:** harness для covered-LP должен включать НЕ только `applyV3CostBasisOverride` (slot0), но и **`applyKrystalV3Override`** — covered V3/V4/CL startUsd = **Krystal** `totalDepositValue`/Σ DEPOSIT (authoritative, locked-decision), а slot0 = fallback. Эмпирически: v3-only harness дал 16/80 fail (POS-011 slot0 $475 vs Krystal $501; V4/Pancake без slot0-cb вообще). **Добавлено в harness (всё green 602/602):** step 4.7 `applyKrystalV3Override(working, krystalV3ByTokenId, walletAddrById, krystalTxByTokenId)` после CEX; `ReplayInput.krystalV3ByTokenId`+`krystalTxByTokenId`; fixture format + serializer/loader; dev-хук публикует `krystalV3.data`+`krystalTxHook.data`. Импорты krystal/override+adapter безопасны в test-env. **БЛОКЕР:** браузер после моих reload'ов потерял загруженные кошельки («Нет загруженных кошельков») + перезапись temp-capture стёрла v3-only дамп. **NEXT: owner перезагружает кошельки на /performance (чтобы LoadedWalletsProvider их подтянул) → 1 capture (v3+krystal, bigint-tagged) → `node scripts/build-mmaksimuk-fixtures.mjs` → replay green → 17 V3/V4/CL anchors (MMaksimuk 1/2) в регрессе. Golden-цель закрыта.** Verified-числа готовы (vs Krystal). `scripts/build-mmaksimuk-fixtures.mjs` + ANCHORS-список в репо.
> - ✅ **A3.2 — Phase 3 (V3) первая попытка (история, заменена выше).** Цель: вшить 5 проверенных-vs-Krystal V3-эталонов (POS-006 в 1s, POS-008/010/011 в 2s, POS-009 в 3s) в оффлайн-регресс — закрывает Golden-цель. **Код готов и протестирован:** (1) проверил что `applyV3CostBasisOverride` импортится в чистый harness без краша React (27/27 replay green); (2) `replay_positions.ts` — `ReplayInput.v3PositionMap`+`v3CostBasis` (frozen) + guarded step 2.5 (V3 override ПЕРВЫЙ в цепочке, mirror useComputedPositions; Krystal startUsd НЕ трогает — подтверждено); (3) **bigint-кодек** `tagBigints`/`reviveBigints` в `golden_fixture.ts` (V3 типы несут bigint tokenId/liquidity/amounts → JSON их не держит; generic tag `{$bigint:"…"}`/revive) + прокинут в serializer/loader; (4) dev-хук `use_computed_positions.ts` публикует `v3.data`+`v3CostBasisHook.data` (raw, tag при capture). **Гейты: replay 29/29 (вкл. bigint round-trip offline-тест: tag→JSON→revive→bigint), web vitest 602/602.** **БЛОКЕР:** браузерная сессия chrome-devtools РАЗЛОГИНИЛАСЬ (только cap_csrf, нет auth) → capture-хук не запускается (страница за auth). **NEXT: owner логинится (admin→impersonate testakk→/performance) → captured v3 данные → собрать testakk-1s(+POS-006)/2s/3s.json → replay воспроизводит V3 startUsd → Golden-цель закрыта.** Числа уже верны (vs Krystal 0.2%), осталась механика захвата.
> - ✅ **A3.2 — Phase 2 (non-LP) DONE + verification workflow всех 11 (2026-05-31).** **Harness расширен:** `ReplayInput.nonLpOpenerByKey` (frozen Map) + guarded step 5 `applyNonLpOpenerOverride` в `replay_positions.ts` (mirror useComputedPositions tail; V3/Krystal steps no-op для non-LP → порядок сохранён). Fixture format + serializer + loader прокинуты. **Fixture `testakk-1s.json`** (wallet 1s, 233 ops + live + 6 openerEntries, 176KB) асёртит **6 non-V3 якорей**: POS-001/002 (clean), POS-004 (SPYx caveat), POS-003 Avantis $1737.25, **POS-005 GLV $1300** (наш фикс, regression-locked — без opener-override было бы ~$1434), POS-007 $1498.80. Старый morpho-only fixture удалён (superseded). **Гейты:** replay 27/27, web vitest **600/600**. **🔬 Verification workflow (dynamic, 11 агентов параллельно, read-only от chain_operations, 452k токенов):** confirmed=POS-001/002; caveat=POS-004/003/005/007/006/010; **suspect=POS-008/009/011**. Ключевой вывод: для non-LP (003/005/007) verdict=caveat НО `startUsdGrounded=true` — число точь-в-точь из OUT-side стейблов реестра (POS-005 seq-55 OUT 1300 USDC), caveat только про messy derivation jsonb (engineTraced=false) → безопасны как number-regression. **⚠️ V3 `suspect` — ЛОЖНАЯ ТРЕВОГА (неправильная линейка, исправлено owner 2026-05-31):** агенты сверяли V3 с РЕЕСТРОМ (`chain_operations.movement.usd`) — это НЕВЕРНЫЙ источник для LP. Per locked-decision [[capflow_data_source_authority]]: **LP cost basis = Krystal Σ DEPOSIT (primary) / Etherscan slot0 (fallback), НЕ реестр.** Реестр для V3 неполон (DeBank видит 1 из 3 IncreaseLiquidity → $56 вместо $159) + sync-time priced. Числа на деле совпадают с slot0-методом ([[capflow_v3_cost_basis]]): POS-008 PAXG/USDC $1180.86 ↔ slot0 $1180.82; POS-011 XAUt $159.12 ↔ Etherscan-3-events $159.04. **→ V3-goldens ПОДТВЕРЖДЕНЫ vs Krystal (curl /v1/positions/1/{NFPM}-{tokenId}, 2026-05-31):** все 5 сходятся с Krystal `performance.totalDepositValue` в пределах 0.2% — POS-006 $1121.82↔$1122.20, POS-008 $1180.86↔$1180.82, POS-009 $1568.45↔$1571.63, POS-010 $228.11↔$228.41, POS-011 $159.12↔$159.01. «suspect» был чисто артефактом неправильной линейки (реестр). **V3-goldens ВЕРНЫ.** V3 fixtures всё равно ждут B3 (V3-override entangled с `@/lib/v3`, в чистый replay-harness пока не тащим), но числа доверенные. Урок записан в [[capflow_data_source_authority]]: LP-эталоны сверять с Krystal, не с реестром; 28 протоколов авто-роутятся через Krystal.
> - ✅ **A3.9 — M6 partial-coverage реализован: uncovered → open-time price, no suppress (2026-05-31).** Правило (owner): непокрытый остаток в lot-traced позиции → цена на момент открытия (supply-op), помечен `pricedPct`, PnL/feeApr НЕ гасим. Фикс в `open_positions.ts buildOne` блок `lotConsumed` (≈2384): covered=`lotCb.totalCostUsd` (trusted, FIFO/LIFO/WAC), uncovered=`lotCb.uncoveredAmount × (cycleDeposit.usd/amount)` (open-priced), `amount=covered+uncovered` (full supplied), `fallbackUsd=uncoveredUsd` (провенанс-ярлык). Один блок — startUsd/startAmount/provenance корректны без правки веток; full-coverage позиции не затронуты (uncovered=0). **Verified live:** POS-007 (Aave V3 eth) WETH $21 887 trusted + **WBTC $18 107 open-priced (no purchase trace, fb flagged)** + USDT stable = startUsd $45 182, **PnL −$3 109 показывается** (не гашено). POS-005 теперь $12 211 full-coverage (прошлое расхождение было stale-sync — #2 закрыт). Gates: ucb tsc 0, vitest 557/557, vite build ✓. Записано M6-ревизия (мастер-план) + KB §1d + [[capflow_golden_case_authoring]]. #1 FIFO==LIFO РАЗОБРАНО (2026-05-31): движок корректен — diagnostic 6-из-12 ETH даёт FIFO $8k / LIFO $16k / WAC $12k / HIFO $16k (все разные). Live FIFO==LIFO = позиции потребляют ВЕСЬ прослеженный пул (consume≥pool → порядок не важен → FIFO=LIFO=Σ), WAC отличается из-за усреднения по пулу + multi-consume нормализации. НЕ баг. Закреплено регресс-тестом `lots/methodology.test.ts` (partial→differ, full→equal). vitest 559/559.
> - ✅ **A3.8 — Lot FIFO/LIFO/WAC toggle fix + lending methodology verification rule (2026-05-31).** Баг: переключатель `Lot:` НЕ менял lending startUsd (все 3 идентичны). Root cause: `methodology` хардкод `"WAC"` в `open_positions.ts buildOne:2366`; `BuildOptions`/`buildOpenPositions`/`buildOne` не принимали методику; page-toggle `lotMethodology` не прокидывался (а override-path `applyLendingCostBasisOverride` глушился `allFromCostBasis` guard). Фикс: пробросил `methodology` через `BuildOptions → buildOpenPositions → buildOne(line 2366)` + `use_computed_positions.ts` передаёт `lotMethodology` в опции + в useMemo deps. Verified live: WAC ≠ FIFO/LIFO на 3 lending (Fluid eth $12.2k WAC vs $12.4k FIFO; Aave V3 arb $39.4k vs $37.2k; Aave V3 eth $27.4k vs $25.9k). Gates: ucb tsc 0, web vitest 557/557, vite build ✓. Правило в [[capflow_golden_verification_protocol]] §2b: для lending проверять все 3 методики. **Открытое:** FIFO==LIFO на всех трёх (выверить — полное потребление или impl-нюанс); POS-005 display($12.2k)≠WAC-trace($15.3k) → display берёт cycleDeposit, не lot-trace. **Новый паттерн всплыл:** Aave V3 (rebase aToken) — добрали в покрытие.
> - ✅ **A3.7 — golden KB built + Krystal/data-source incident (2026-05-31).** Юзер разметил **14 эталонов** (testakk, кошельки Murat+Artur, все arb): 7× GMX V2 GM-LP, 4× Fluid lending, 1× Morpho GLV, 2× Uni V3. Все изучены, синтез методологии → `notes/golden/knowledge-base.md` (паттерны, service-timing, инварианты для порта, caveats). Структурный провенанс — в `golden_cases.derivation` (WAC lot-trace + sourceHash). **Критический инцидент (POS-004/005):** Fee=«—» при APR>0 — я ошибочно проверил только DeBank и обнулил APR (defensive, не тот слой); реальный root cause — отсутствовал `KRYSTAL_API_KEY` в `.env` → upstream-proxy 503 → Krystal-override (authoritative для LP fee/APR) пропускался. Фикс: ключ в `.env` + рестарт api; мой фикс откатан. Новая память [[capflow_data_source_authority]] — карта «сервис→данные→роль» (Krystal=LP primary). Caveats в KB: POS-012 engineTraced=false (0.009 ETH uncov), GMX per-token avgBuyPrice back-solved артефакт (USDC≠$1), fee APR методология (наш аннуализ vs Krystal feeApr) — открытый вопрос.
> - ✅ **Wallet-delete immediacy fix (2026-05-31).** `useDeleteWallet` now optimistically drops the wallet from the cached `["wallets","list",accountId]` query + `removeQueries` its addresses, THEN invalidates — so `useWalletsHydration` rebuilds localStorage in lockstep and `LoadedWalletsProvider` prunes it from positions/registry WITHOUT a page reload / cache clear (prev: relied on async refetch lag → deleted wallet lingered until manual cache clear).
> - 🔑 **A3.6 — REFRAME (owner directive 2026-05-31): golden = system-DERIVED-from-ops, not manual.** The single source of truth is the **blockchain operations** (`chain_operations` registry). The operator does NOT type an expected value or pick a "source of truth" — they only assert "this position is correct". The system MUST then analyze that position's ops and DERIVE the cause-effect of WHY the number is right (which ops are buys/supply, how cost basis flowed, which lots were consumed), and store that derivation in the UCB server as a **knowledge base** — so we understand how things SHOULD compute and recognize similar patterns. A wrong position likewise traces to the chain: ops mis-pulled/mis-classified OR engine miscalculation. Globally every number reconciles to on-chain ops. **Changes:** (a) dialog drops the manual `sourceOfTruth` dropdown + manual `expected` (source is always "chain ops"); (b) `golden_cases` gains a `derivation` jsonb (the ops feeding the position + the lot-consumption/cost-flow trace) — captured by extending the replay/engine to EMIT its trace; (c) marking golden runs the derivation capture; (d) the derivation is the durable knowledge for pattern-matching + engine fixes. Honest scope: the engine already computes the number from ops; this makes it EMIT the why-trace. NOT auto-ML — the recorded derivation is what lets me/the detector enforce the pattern on similar positions.
> - ⏳ **A3.5 (NEXT):** curate the real incident anchors on testakk (POS-011 Velodrome $237.80, EUR-stable, WBTC/BTC, C11, POS-007/008 GMX) using ★ → golden/wrong, then the fixture-export path (serialize each anchor's `ReplayInput` → committed `__fixtures__/golden/*.json` for offline regression). The running stack is now OURS (api+web from `condescending-fermi`).

**🚀 Promote to prod.** Gate: A1 migration live; golden API behind admin/owner guard; CI green; seeded fixtures committed and green (except those intentionally red pending the B-epic fix, tracked as known-failing anchors, not merged red into the blocking suite). **Migration:** none new.

---

## EPIC B — Server-side UCB port

All B-stages B1–B4 are **cache-fill only** (no served-output change); B5 is **shadow-only**; only B6 flips serving — so prod risk is contained until the final flagged flip, which keeps client recompute as a permanent fallback.

### Stage B1 — `op_token_prices` cache + op-pricing service

> **🔬 ОБОСНОВАНИЕ ПОДТВЕРЖДЕНО ДАННЫМИ (2026-05-31).** Расследование POS-005
> (deposit_fiat/seed cost-basis гуляет) вскрыло корень: `chain_operations.raw.
> movement[].usd` — это цена **на момент СИНКА**, не фиксированная на блок. Измерено
> на testakk: **560/2260 tx (25%) задублированы между кошельками, 531 cross-account**
> (один адрес в 2 аккаунтах, каждый синкнул со своей ценой); **156 расходятся >1%,
> 26 >5%, max 25.9%** (deposit_fiat/swap/lend_supply/lp_add/claim — все типы). Один и
> тот же on-chain tx → разные USD → **недетерминированный cost basis** (POS-005:
> $2761.70 vs $2545.71 на тот же ETH в разное время разметки). **Именно это лечит B1:**
> детерминированная оценка каждого acquisition-движения по фикс-цене на блок
> (DefiLlama @ blockTime), кеш `op_token_prices`, + канонизация реестра (одна строка
> на `(chain,tx_hash,log_index)`, не per-wallet-per-account копии). После B1 cost
> basis идентичен независимо от аккаунта/синка. Детектор: `duplicate_op_divergent_pricing`,
> `swap_movement_imbalance` (см. C5b).

> **⚙️ B1.1 DONE (2026-05-31):** schema `packages/db/src/schema/op_token_prices.ts` + migration `0029_op_token_prices.sql` applied to local dev DB (table verified). **DEVIATION (deliberate):** PK = `(coin, hour_bucket)` NOT plan's `(chain, token_id, hour_bucket)` — `coin`=`defillamaCoinKey` is DefiLlama's pricing unit + matches client `cacheKeyFor()` Map key (`${coin}|${bucketTs}`) byte-for-byte; `chain`/`token_id` kept as descriptive cols. `hour_bucket`=bigint epoch-seconds (`floor(t/3600)*3600`). `@cap-flow/db` build clean.
> **⚙️ B1.2-B1.4 DONE (2026-05-31):** added `@cap-flow/ucb` to apps/api deps. `apps/api/src/modules/ucb/op-pricing.repository.ts` (getByKeys tuple-IN + priced_ok filter; upsertMany onConflictDoNothing) + `op-pricing.service.ts`: `collectPriceNeeds(ops)` **byte-for-byte mirror of client `useWalletHistPrices`** (non-failed; per movement: amount>0, !gasETH<0.01, !isStable, !isProtocolToken, dir in|out, coin resolvable, dedupe coin+hour), `priceMapForOps(ops)` → `{histPrices Map(`${coin}|${bucketTs}`→price), missing[]}` (cache-read), `fillMissing(missing)` → DefiLlama batcher (injectable fetcher, worker-pool concurrency 4, chunk≤50, **R5: only price>0 cached, never on 503/empty**). Tests `op-pricing.service.test.ts` **6/6**: filter parity, dedupe, client-identical `cacheKeyFor` key, miss-list, R5 (price>0 cached / empty→nothing). api build tsc 0. **REMAINING for full B1:** (a) worker wiring — scheduled BullMQ job to run priceMapForOps+fillMissing over wallets' ops (cache-fill only, not served); (b) deeper golden-parity fixture (deep-equal server histPrices vs frozen client export for bob). Core pricing logic + R5/R1 done; wiring deferred. NEXT (per owner): разметка эталонов + A3.2 fixture-export.

> ✅ **B1.5 — worker-wiring DONE (2026-06-02, commit `b521994`).** Recurring op-pricing cache-fill job (the deferred (a) above). `op-pricing-fill.service.ts::OpPricingFillService.run()` sweeps `accountsRepo.findAllActive()` → `loadComputeWalletsForAccount` → `priceMapForOps` → `fillMissing`; fail-soft per account, sequential (R8 + free cross-account dedup), honors an AbortSignal mid-sweep + forwards to fillMissing. `op-pricing-fill.queue.ts::OpPricingFillQueue` (payment-monitor pattern, single global recurring job, scheduler id `op-pricing-fill`) + `worker.ts` wiring (Worker concurrency 1, scheduleRecurring 30 min, worker-scoped AbortController aborted on shutdown, close in teardown). **Cache-fill ONLY — serves nothing, no feature flag** (safe/invisible). Built via a dynamic SCOUT workflow (4 parallel integration-point scouts) + hardened via an adversarial REVIEW workflow (2 lenses; caught the missing AbortSignal pass-through → fixed). Gates: `op-pricing-fill.service.test.ts` 5/5, api **993/993**, tsc 0 new. **Live e2e (dev DB):** 9 accounts, 3119 ops, 1014 (coin,bucket) needs → **401 prices written**; 2nd run writes 0 (idempotent); 613 DefiLlama-unpriceable keys correctly never cached (R5), matching the client's same-DefiLlama limitation (server==client preserved). **REMAINING for full B1:** only (b) deep golden-parity fixture (deep-equal server histPrices vs a frozen client export) — optional regression hardening. ⚠ The shadow runner reads the cache via `priceMapForOps` but does NOT itself call `fillMissing`; this job is what populates the cache it reads — so for the shadow compute to actually USE block-fixed prices, this fill job must have run first (cadence 30 min covers it).

**Headline schema decision (risk R1).** `historical_prices(symbol,date)` is *already shared* between two meanings: `cex/historical-fx.service.ts` writes ISO-4217 FX rates (`EUR`,`GBP`) with `onConflictDoNothing` into the same PK token enrichment would use — and `EUR` is also the symbol of EUR-stablecoins we previously mispriced. **Token enrichment MUST NOT reuse `historical_prices` keyed by bare symbol.** New shared table keyed by the objective fact:

```sql
-- packages/db/drizzle/0026_op_token_prices.sql  (additive, no user_id)
CREATE TABLE op_token_prices (
  chain        text NOT NULL,
  token_id     text NOT NULL,         -- contract address or native sentinel
  hour_bucket  timestamptz NOT NULL,  -- floor(op_time,1h) — matches client Math.floor(time/3600)
  price_usd    numeric(28,8) NOT NULL,
  priced_ok    boolean NOT NULL DEFAULT true,   -- R5 outage guard
  source       text NOT NULL,         -- 'defillama' | 'op_raw'
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, token_id, hour_bucket)
);
```

**Sub-tasks**
- `apps/api/src/modules/ucb/op-pricing.service.ts`: `priceMapForOps(ops)` builds the same `defillamaCoinKey|hourBucket → price` map shape `ucb_pipeline`'s `histPrices` expects, reading `op_token_prices` (+ `historical_prices` for FX only), using `defillamaCoinKey` from `@cap-flow/ucb/pricing` so keys match the client byte-for-byte.
- Cache misses fetched via the **existing POS-024 bounded-concurrency DefiLlama batcher** (commit e549b20), hard `p-limit(4)`, never one-per-op unbounded (risk R6).
- **R5 guard:** never write a row on a failed/zero/low-confidence lookup; set `priced_ok=false` and skip serving, mirroring the client's `hasHistPrices:false` drop.
- All shared-cache writes `onConflictDoNothing` (immutable facts; safe under the `concurrency:5` worker race, risk R7).

**✅ Test (local).** `op-pricing.service.golden.test.ts`: feed bob's captured `ClassifiedOp[]`, stub `op_token_prices` rows, assert the produced `histPrices` map deep-equals a frozen export from the client `useComputedPositions` for the same ops (DefiLlama mocked → offline). R1 test: insert `EUR`/2026-01-01 via the FX path, then run token enrichment for a EUR-stable same date → assert two distinct rows and client/server agree on the EUR-stable USD. R5 test: mock DefiLlama 503 → assert no priced row written. Run the local worker for bob; log concurrency ≤ cap.

**🚀 Promote to prod.** Gate: `0026` applied first; worker env keys present (`DEFILLAMA_BASE_URL`) verified via `docker compose config`; **cache-fill only — not wired into served metrics**; watch `api_usage` for a bounded DefiLlama rate. **Migration:** `0026` additive.

---

### Stage B2 — Wire in the already-server-side CEX cost basis

**Sub-tasks**
- `apps/api/src/modules/ucb/cex-cost-basis.adapter.ts` wraps the existing `CexCostBasisService` + `deposit-seeds.service.ts` to emit the `Map<txHashLower, CexCostBasisMatch>` shape the client builds (`useComputedPositions` lines 107–117) that `applyCexInheritanceCostBasisOverride` (now in `@cap-flow/ucb`) consumes. Pure transform, no new external calls.

**✅ Test (local).** `cex-cost-basis.adapter.test.ts`: given fixture `cex_trades` / `cex_deposit_seeds` for bob, assert the map equals the client's `cexCostBasisByHash` snapshot (reuse existing `cex.cost-basis.service.test.ts` fixtures). Build the map server-side locally; assert it matches the browser log.

**🚀 Promote to prod.** Gate: CI green; **shadow-only** (consumed only by B5). No served change. **Migration:** none.

---

### Stage B3 — Persist V3 enrichment → port V3 override

**Sub-tasks**
- Migration `0027_v3_enrichment.sql` — two **shared** tables (no `user_id`), keyed by chain+nft+block:

```sql
CREATE TABLE v3_liquidity_events (
  chain text, npm_address text, token_id text, event_type text,  -- increase|decrease|collect
  block_number bigint, log_index int, block_time timestamptz,
  amount0 numeric(40,0), amount1 numeric(40,0), pool_price_x96 numeric(80,0),
  priced_ok boolean NOT NULL DEFAULT true,                       -- R5
  source text NOT NULL DEFAULT 'etherscan_v2', fetched_at timestamptz DEFAULT now(),
  PRIMARY KEY (chain, npm_address, token_id, block_number, log_index)
);
CREATE TABLE v3_position_snapshots (
  chain text, npm_address text, token_id text, owner text,
  tick_lower int, tick_upper int, liquidity numeric(40,0),
  token0 text, token1 text, fee_tier int, snapshot_at timestamptz DEFAULT now(),
  PRIMARY KEY (chain, npm_address, token_id, snapshot_at)
);
```

- `apps/api/src/modules/ucb/v3-enrichment.service.ts` ports the fetch logic from `apps/web/src/lib/v3/liquidity_events.ts` + `v3/hook.ts` (Etherscan v2 Increase/Decrease/Collect logs + slot0 via `eth_call`; Alchemy `positions()`). The EUR-stable rule and POS-011 gauge matching live in the override fn already moved to `@cap-flow/ucb` (reused unchanged).
- **POS-024 boundedness (risk R6):** reuse the V3-event limiter from commit 106e296, per-NFT concurrency ≤ 4; persist-on-fetch; mirror the `use_liquidity_events.ts:312` outage-poison guard (`priced_ok`, risk R5). **Etherscan FREE-tier ceiling (risk R6):** global token-bucket 3/s shared process-wide, per-day budget counter in `api_usage`, exponential backoff on 429, partial failure marks the wallet `sync_error` (never crashes the refresh).

**✅ Test (local).** `v3-override.golden.test.ts`: load fixture `v3_liquidity_events` + `v3_position_snapshots` for the **POS-011 anchor (NFT 3427422)** and the EUR-stable anchor; run `applyV3CostBasisOverride` from `@cap-flow/ucb`; assert `startUsd ≈ $237.80` (not $20.40 / $0), gauge emissions used for fees (not on-chain pendingFee, R14), and EUR-stable priced ≠ $1 (offline). Backfill bob's V3 NFTs locally; assert tables populate and the override matches the browser. Load test: 50 wallets → Etherscan rate ≤ 3/s; kill the key mid-run → graceful per-wallet errors, no worker crash.

**🚀 Promote to prod.** Gate: `0027` applied first; Etherscan/Alchemy keys present on the **worker** container (`docker compose exec worker env`); ship as a **bounded cache-fill cron stage**, shadow-only; watch `api_usage` rate. **Migration:** `0027` additive.

> 🔎 **B3-FULL SCOPING (2026-06-02).** B3 (Krystal path) is done; B3-FULL = the slot0/Etherscan cost basis for NON-Krystal-covered V3 LP (incl. the Velodrome gauge POS-011 $237.80, broken everywhere incl prod — see [[capflow_velodrome_gauge_backlog]]). **Prereq:** `applyV3CostBasisOverride` is NOT yet in `@cap-flow/ucb` (only cex + lending overrides are; the web replay harness imports it from `@/lib/portfolio/v3_cost_basis_override`). So slice 1 = extract `v3_cost_basis_override.ts` (+ its `@/lib/v3` React/localStorage deps — the A0 "Tier 3 deferred" module) into the pkg, injecting the v3 hook/liquidity-events data instead of importing the React hook. Slice 2 = server `v3-enrichment.service.ts` (Etherscan Increase/Decrease/Collect logs + slot0 `eth_call` + Alchemy `positions()`), migration 0027 (`v3_liquidity_events` + `v3_position_snapshots`), R5/R6 bounded. Slice 3 = wire `applyV3CostBasisOverride` into `computePositions` (FIRST in the chain, before Krystal — mirror `use_computed_positions.ts:383`). **Verify against POS-011 NFT 3427422 = $237.80** (gauge emissions for fees, not on-chain pendingFee, R14) + EUR-stable anchor. Heaviest external-API stage (Etherscan FREE-tier ceiling, R6). The shadow-diff presence-mismatch (client has matchedV3TokenId, server doesn't) currently flags this as the gap to close.

---

### Stage B4 — Persist receipt-token transfers → port lending + non-LP opener

**Sub-tasks**
- Migration `0028_receipt_token_transfers.sql` — shared (no `user_id`), keyed by chain+token+tx:

```sql
CREATE TABLE receipt_token_transfers (
  chain text, receipt_token text, tx_hash text, log_index int,
  from_addr text, to_addr text, amount numeric(40,0), block_time timestamptz,
  priced_ok boolean NOT NULL DEFAULT true,                        -- R5
  source text NOT NULL DEFAULT 'etherscan_v2', fetched_at timestamptz DEFAULT now(),
  PRIMARY KEY (chain, receipt_token, tx_hash, log_index)
);
```

- `apps/api/src/modules/ucb/receipt-transfers.service.ts` ports `apps/web/src/lib/lending/use_lending_audit.ts` + `apps/web/src/lib/nonlp/use_opener_detector.ts` fetch logic. Override fns (`applyLendingCostBasisOverride`, `applyNonLpOpenerOverride`) come from `@cap-flow/ucb`. Bounded (≤4 concurrent), persist-on-fetch, `priced_ok` guard, shared Etherscan token-bucket (R6).

**✅ Test (local).** `lending-audit.golden.test.ts` + `nonlp-opener.golden.test.ts`: Aave-supply-without-mint and Gnosis-Safe-opener fixtures; assert lending `startUsd` and non-LP `openedAt`/`ageDays` match client snapshots. Backfill bob; diff override output vs browser.

**🚀 Promote to prod.** Gate: `0028` applied first; worker env verified; bounded cache-fill cron stage, shadow-only. **Migration:** `0028` additive.

> 🔎 **B4 SCOPING (2026-06-02, code-mapped — turnkey impl plan).** Confirmed B4 is a 4-slice feature, NOT a quick add. **✅ Slice 1 DONE (commit `7bb3b52`)** — extracted `non_lp_opener.ts` (OpenedInToken/NonLpOpener/keyOf/nonLpOpenerKey) + `apply_opener_override.ts` into `@cap-flow/ucb`; web re-export shims (import sites unchanged); pkg build clean, web opener+replay 184/184, web 718/718, api ucb 61/61, vite build ✓, 0 new tsc. Zero behaviour change — the override is now available server-side (still a guarded no-op until slice 4 feeds it). **Slice 1 (orig description) — extract pure opener into `@cap-flow/ucb` (A0-style, zero behaviour change).** The override `apps/web/src/lib/nonlp/apply_opener_override.ts` IS pure (no fetch/React/window) but has nested web entanglements to resolve into one new pure pkg module `non_lp_opener.ts`: (a) `NonLpOpener` + `OpenedInToken` types live in the FETCH file `opener_detector.ts`; (b) `nonLpOpenerKey` → `keyOf` live in the HOOK file `use_opener_detector.ts`. Move types+key helpers → `packages/ucb/src/non_lp_opener.ts`; move `apply_opener_override.ts` → pkg (imports `./non_lp_opener.js` + `./open_positions.js`); web re-export shims at all old paths so `opener_detector.test.ts` (24) + `apply_opener_override.test.ts` (26) stay green. Gate: pkg build + web vitest + golden replay + vite build. **Slice 2 — server fetch service** `receipt-transfers.service.ts` porting `opener_detector.ts` (Etherscan logs `../etherscan_logs` + Alchemy `./alchemy_transfers` + `./cost_basis` + `../defillama`) → produces `nonLpOpenerByKey: Map<key, NonLpOpener>`. Bounded ≤4 (R6 Etherscan FREE-tier token-bucket), R5 priced_ok, persist to `receipt_token_transfers`. **Slice 3 — migration 0028.** **Slice 4 — wire** `applyNonLpOpenerOverride` into `ucb.service.ts computePositions` (after Krystal V3, mirroring `use_computed_positions.ts:526`; guarded no-op when map empty). **Verify:** the shadow-diff M5 `openedAt` field now flags the gap — after B4, materialDivergenceCount should drop for non-LP positions (GMX/lending dates). **NOTE:** the `lendingAudit` half is a CLIENT flag (`capflow.feature.lendingAudit`, default OFF) → porting it has LOW parity value now (client doesn't use it by default); B4's real parity win = the non-LP opener (openedAt). Defer lending-audit.

---

### Stage B5 — Server `ucb.service` orchestrator (shadow mode) — the keystone

> **⚙️ B5 COMPUTE-ONLY SCAFFOLD DONE (2026-06-01, dynamic-workflow pick).** The
> keystone slice that proves **server computes client-identical numbers** landed.
> `apps/api/src/modules/ucb/ucb.service.ts::computePositions(wallets, deps)` —
> imports ONLY from `@cap-flow/ucb` (subpaths: `ucb_pipeline`, `open_positions`,
> `lending_cost_basis_override`, types), mirrors `replay_positions.ts` steps 1→3:
> (1) `runUcbPipelineForWallet` per wallet → lot tracker, (2) `buildOpenPositions`
> (empty V3-lp histPrices), (3) `applyLendingCostBasisOverride`. `histPrices` from
> B1 via an injected `OpPriceSource` (DB-free, structurally `OpPricingService`).
> CEX(B2)/V3(B3)/non-LP(B4) are deliberate guarded no-ops (absent inputs) — a
> non-V3/non-CEX position computes IDENTICALLY to the client. **Test-first proof**
> `ucb.service.shadow-replay.test.ts` (3 tests) on frozen golden fixtures
> (`__fixtures__/ucb-shadow/`): synthetic Aave startUsd=$2000 (cost basis, not
> $3000 spot) **+ real testakk Fluid WBTC startUsd=$1068.53 (server == client,
> ±0.5%)** + determinism R4 (100%→byte-identical). Gate: `@cap-flow/ucb` dist +
> api ucb tests **9/9** + tsc clean (ucb). **NO DB write, NO route, NO flag** in
> this slice. **Deferred B5 follow-ups:** `0029_ucb_shadow_results` migration +
> write path; `ClassifiedOp` loader from `chain_operations.raw` (R13 filter) +
> refresh-worker wiring; `POST /ucb/shadow-diff` comparator; `capflow.feature.
> ucbServerShadow` flag; B2/B3/B4 override-input parity. Picked over B2-cex
> (shadow-glue, no consumer until B5) / B1-wiring (lower altitude) / B3-v3 (heavy
> React extraction) by the assessment workflow (value 5, risk 2, achievable-now).
>
> **⚙️ B5 FOLLOW-UP BUILDING BLOCKS DONE (2026-06-01, scout-workflow plan).** All
> reusable B5 pieces landed + gated (api ucb 35/35, tsc clean), each its own
> commit: (1) `shadow-diff.ts` pure comparator (client vs server startUsd deltas,
> stable composite key, 7 tests); (2) `ucb_shadow_results` table (migration 0030
> applied, account-scoped FK-cascade); (3) `ucb-ops.repository.ts` loader
> (chain_operations.raw → UcbComputeWallet[], R13 filter, op_time ASC, pure core
> tested, 5); (4) `ucb-shadow.repository.ts` write+read+diff-update (pure mappers,
> 4); (5) `ucb-shadow.service.ts` flag-gated compute+store orchestration,
> fail-soft, `UCB_SERVER_SHADOW_FLAG` const (5). **NOTE: scout workflow assessed
> the WRONG worktree** (session-root `romantic-brahmagupta` @0024, not
> `condescending-fermi` @0029 where the work is — special-char path broke agent
> nav) → its "Step 0: port foundation" was a false alarm + migration renumbered
> 0026→0030; implemented inline instead. **REMAINING (final app-integration, NOT
> yet done):** (6) instantiate `UcbShadowService` in the composition root + call
> `runForAccount` in `PortfolioRefreshService.refreshAccount` after the live
> snapshot, mapping refresh-internal live → `@cap-flow/ucb` `LiveSnapshot` per
> wallet; (7) `POST /ucb/shadow-diff` route (`.routes.ts` pattern — api uses
> routes, NOT NestJS controllers — auth + body DTO → `findLatestForAccount` +
> `diffShadowPositions` + `updateDiffSummary`). Both touch the running app
> (core refresh path + route registration), best done with app-context care.
>
> **⚙️ ROUTE CORE DONE (2026-06-01).** `ucb-shadow-diff.handler.ts::runShadowDiff`
> (framework-free: findLatest → diffShadowPositions → updateDiffSummary, surfaces
> `no_shadow` vs zero-divergence; 3 tests). api ucb now **33/33**, tsc clean.
> **TRUE REMAINDER (all app-integration — needs a running-app/integration harness
> this env lacks; deliberately NOT half-built):**
> - **6a — DeBank→LiveSnapshot adapter port (the real piece-6 blocker, newly
>   surfaced).** The engine needs `@cap-flow/ucb` `LiveSnapshot` to build
>   positions, but the server's `portfolio-refresh.service.ts` only assembles
>   DeBank-shaped data (its "Slice 5"). The client adapter `apps/web/.../portfolio/
>   live_adapters.ts` (765 LOC, 5 adapters; PURE — no React/localStorage) is
>   web-only. Port the EVM path `adaptDeBankLive` (~200 LOC) into a shared/server
>   pure module. ⚠ No raw-DeBank test fixture exists (golden fixtures freeze the
>   OUTPUT `live`, not the DeBank INPUT) → capture a raw DeBank summary for a
>   testakk wallet to gate the port byte-for-byte vs the client.
> - **6b — composition-root DI + refresh call.** Instantiate `UcbShadowService`
>   (+ UcbOpsRepository, UcbShadowRepository, OpPricingService, FeatureFlagsService,
>   engineVersion) where services are wired; call `runForAccount(accountId,
>   {trigger:'refresh', liveByWalletId})` in `refreshAccount` after the live
>   snapshot (built via 6a), fail-soft.
> - **7-attach — Fastify route.** `ucb.routes.ts`: `route.addHook('preHandler',
>   app.requireAuth)`; `route.post('/ucb/shadow-diff', {schema:{body}}, ...)` →
>   resolve accountId from `req.user`, call `runShadowDiff`. Register in the app +
>   inject the repo. Body = client `OpenPosition[]` (loose `z.array(z.unknown())`
>   — internal shadow endpoint).
>
> **State:** every TESTABLE B5 unit is built + gated (compute engine, comparator,
> table+migration, loader, repo, worker-service, route-core — 33 tests). What's
> left is purely binding them into the live Fastify app + the BullMQ refresh path
> + the one ported adapter — integration work that belongs in a session with the
> app running and a raw-DeBank capture in hand.

**Sub-tasks**
- Migration `0029_ucb_shadow_results.sql` — **user-scoped** (row-level isolation):

```sql
CREATE TABLE ucb_shadow_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  computed_at timestamptz NOT NULL DEFAULT now(),
  positions jsonb NOT NULL,            -- server OpenPosition[] post-override
  engine_version text NOT NULL,        -- @cap-flow/ucb pkg version + git sha
  diff_summary jsonb                    -- filled by shadow-diff comparator
);
```

- `apps/api/src/modules/ucb/ucb.service.ts`: (1) load ops from `chain_operations.raw` per wallet → `ClassifiedOp[]` (filter `status==="failed"`, R13); (2) assemble inputs: `histPrices`←B1, `cexCostBasisByHash`←B2, V3←B3, receipt transfers←B4; (3) **apply `chain_operation_annotations` precedence server-side** (excluded → drop, `manualCostBasisUsd` → override, `manualOpType` → reclassify) before WAC — risk R9; (4) `runUcbPipeline()` then `applyAllOverrides()` from `@cap-flow/ucb` (the shared single ordering, R4).
- Port `buildOpenPositions` into `@cap-flow/ucb` with `typeof window` guards replaced by an injected `env.isBrowser` flag (guards are diagnostic logging only — not math). The server feeds the DeBank live snapshot already collected by `portfolio-refresh.service.ts`.
- Gate behind `capflow.feature.ucbServerShadow` (resolved via `feature-flags.service.ts`, **default OFF**, risk R16). When ON, the refresh worker *additionally* computes and stores `ucb_shadow_results` but does **not** serve it.
- **Shadow-diff comparator (parallel-run req):** new authenticated `POST /ucb/shadow-diff` — the browser POSTs its computed `positions[]`; server compares vs the latest `ucb_shadow_results` for that account and writes `diff_summary` (count of positions with |Δ startUsd| > $1, per-position deltas). Emit aggregate diff stats to `api_usage`/audit (closes observability gap R18). **Flip criterion:** N consecutive refreshes with zero material diffs across the top-K accounts **including every golden anchor**.

**✅ Test (local).** `ucb.service.shadow-replay.test.ts` (keystone golden replay): a frozen bundle per anchor account (bob, POS-011 Velodrome, artur POS-005, EUR-stable) containing ops + all four enrichment tables + DeBank snapshot. Run server `ucb.service` fully offline; assert `positions[]` **deep-equals a frozen export of the client `useComputedPositions` output** (per-position `startUsd`, `currentUsd`, `feesClaimedUsd`, `openedAt`). Tolerance: **exact for cost basis, ±$0.01 float epsilon** (risk R2). R4 stability: re-run 100× → byte-identical USD. R9: annotate a bob op `excluded=true` and another `manualCostBasisUsd` → server matches client. Locally run `ucb.service` for bob → write `ucb_shadow_results` → run the comparator vs the browser's live output → assert zero material diffs.

**🚀 Promote to prod.** Gate: `0029` applied first; `capflow.feature.ucbServerShadow` **default OFF**; deploy dark; turn ON for 1–2 refresh cycles; confirm shadow-diff stays zero on golden anchors (R2/R18). Rollback runbook: tag enrichment writes with `source`+`fetched_at`; bad backfill cleaned via `DELETE FROM <cache> WHERE source=… AND fetched_at > <deploy_ts>` (R17). **Migration:** `0029` additive.

> ✅ **Task #18 — artur ETH Fluid +4.4% RESOLVED (2026-06-02). Root cause: lot-methodology not threaded into `buildOpenPositions`.** Owner decision: the FIFO/LIFO/WAC toggle MUST drive lending startUsd (option B). Diagnosis (test-first, debug-protocol): the server `computePositions` (and the web `replayPositions` harness) called `buildOpenPositions` **without** the `methodology` option, so `buildSupplyToken` (`open_positions.ts:2480 methodology ?? "WAC"`) silently used **WAC** → lending supply cost basis was methodology-INDEPENDENT off-client ($33,708.57 under any toggle), diverging +4.4% from the live client whenever the user picked LIFO. The C7 guard (`lending_cost_basis_override.ts:58`) then skips the methodology-aware override once `buildSupplyToken` yields a `cost_basis` result, so the toggle MUST reach `buildSupplyToken` to matter — the override never gets the chance. **NOT** the harness-input gap the golden caveat guessed; **NOT** a C7 bug; the shared `@cap-flow/ucb` engine was correct. **Fix (3 call sites of `buildOpenPositions`; client was already correct, anti-recurrence #3):** thread `methodology: lotMethodology` in (a) `apps/api/.../ucb.service.ts` and (b) `apps/web/.../replay/replay_positions.ts`, mirroring `use_computed_positions.ts:319`. **Proof:** server on the frozen artur fixture under LIFO → ETH $32,296.72 **to the cent** (= client golden), WAC → $33,708.57, FIFO → $34,122.91 (toggle now lives). New regression test `ucb.service.shadow-replay.test.ts` (#18: LIFO≠WAC + LIFO==$32,296.72). Golden anchor `artur-1.json` ETH tolerance tightened **5%→0.5%**, caveat rewritten. Acceptance harness pinned to **LIFO** (goldens were captured under LIFO). **Live shadow-verify: 14/14 match, 0 diverge** — artur ETH Fluid 0.0% (was +4.4%), murat ETH Fluid 0.0% (was 0.4%). Gates: api **981/981** (+1), web **705/705**, web replay **120/120**, tsc 0 new (36 pre-existing cex/auth test-file errors unchanged). **⚠ B6 follow-up surfaced:** methodology is a per-user localStorage preference the server can't see; the production shadow runner defaults FIFO (app default) while testakk's goldens are LIFO → for true per-user shadow parity, B6 must persist each user's methodology server-side.

---

### Stage B6 — Flip the UI to read server-computed canonical (flagged, with fallback)

**Sub-tasks**
- Promote `ucb_shadow_results.positions` to `GET /ucb/positions`.
- `useComputedPositions` gains a branch: when `capflow.feature.ucbServerCanonical` is enabled (per-user) and the server result is **fresh** (not older than the latest snapshot), return it; otherwise (stale/missing/fetch error/flag OFF) fall back to the existing client recompute path. Keep `positionsRaw` client-side for diagnostics. Public `ComputedPositions` shape unchanged → zero downstream page churn.

**✅ Test (local).** Unit: server positions when flag ON + fresh; client compute when stale/error/OFF. Golden integration: served path and client-compute path produce identical `positions[]`. Flag ON for bob locally → `/positions` and `/positions/:id` render identical numbers served vs recomputed; **kill the API → confirm graceful fallback** to client compute.

**🚀 Promote to prod.** Gate: shadow diffs zero for ≥2 weeks across the full user base; enable `capflow.feature.ucbServerCanonical` for an internal account first, then ramp; **keep the client recompute path as a permanent fallback** (do not delete) and the flag as a one-row kill switch (R16). **Migration:** none.

> ✅ **B6 SLICE 1 — serving endpoint DONE (2026-06-02, commit `d50f500`).** `GET /accounts/:id/ucb/positions` (in `ucb.routes.ts`, requireAuth + `accounts.getById` ownership) serves the account's latest `ucb_shadow_results.positions`. Pure core `ucb-serve-positions.ts::decideServePositions({flagEnabled, shadow, latestSnapshotAt})` → `{serve, reason, positions, computedAt, engineVersion, lotMethodology}` with reasons `flag_off | no_shadow | shadow_error | stale | served`. Freshness = `shadow.computedAt >= latest snapshot.createdAt` (a snapshot newer than the shadow ⇒ a refresh ran without recompute ⇒ stale ⇒ fall back). Per-user flag `capflow.feature.ucbServerCanonical` (NEW, default OFF, distinct from B5 compute flag `ucbServerShadow`). Wired in `app.ts` (featureFlagsService + portfolioRepo). Read-only; flag OFF ⇒ inert. Gates: `ucb-serve-positions.test.ts` 7/7 (all branches), api **988/988**, tsc 0 new. Live testakk: flag OFF→flag_off; flag ON→served 14 positions (LIFO). **Slice 1 is the backbone; the UI adoption is slice 2.**
>
> ✅ **B6 SLICE 2 — UI adoption in `useComputedPositions` DONE (2026-06-02, commit `12064a0`).** Behind `capflow.feature.ucbServerCanonical` (reactive `useResolvedFeatureFlag`), react-query `GET /v1/accounts/:id/ucb/positions` (account = `useActiveAccount()`); the hook adopts server positions ONLY when flag ON + `resp.serve` + **methodology-match** (`resp.lotMethodology === user toggle`) + **wallet-set match**; else keeps the client recompute (permanent fallback, R16). Public `ComputedPositions` shape unchanged (the client override memo renamed `positions`→`clientPositions`; a new `positions` memo selects server-or-client) → zero page churn. Files: `features/ucb/{api,hooks,serve-decision}.ts` (+`serve-decision.test.ts`). **Subtleties resolved (inline scout, the workflow subagents were down):** (1) accountId NOT derivable from the composite wallet id (`api:<walletUuid>:<addr>` — no account in it) → use `useActiveAccount().id`; (2) wallet-set match via `realWalletId(clientPos.walletId)` set === server `p.walletId` set (both pipelines cover the same wallets — guards partial browser loads / multi-account); (3) serialization is a NON-issue — `OpenPosition` is JSON-safe (`openedAt:number|null`, no Date/bigint; the stored jsonb round-trips). **Methodology-match guard = the key design win:** a FIFO-computed shadow is never shown to a LIFO user, so server-side per-user methodology persistence stays an OPTIONAL flip-coverage follow-up, not a blocker. Gates: `serve-decision.test.ts` 9/9, web vitest **714/714**, vite build ✓, web tsc 0 new (250 pre-existing baseline, verified via stash). Flag default OFF → byte-identical to today (fetch disabled, decision false). **B6 is now CODE-COMPLETE (slice 1 serving + slice 2 adoption); the only thing left is the FLIP itself** — enable the flag after the merge→prod shadow-soak shows ≥2wk zero diffs.

> ✅ **Shadow-diff comparator → M5 structural parity DONE (2026-06-02, commit `4344926`).** The flip gate was startUsd-only; M5 (and the slice-2 review finding #2) require more. `diffShadowPositions` now also compares per matched pair: **netStartUsd** (abs threshold), **coverageIncomplete** (bool — coverage must round-trip), **openedAt** (equality — catches the B4 non-LP opener gap), with a `reasons[]` per delta. New summary field **`materialDivergenceCount = divergentCount + clientOnlyCount + serverOnlyCount`** is the TRUE flip gate (0 ⇔ parity): a position present on ONE side only is a real divergence (e.g. a server missing V3 enrichment → different match key → client_only/server_only, which `divergentCount` alone misses). **Flip criterion updated: `materialDivergenceCount === 0` across golden anchors, not `divergentCount === 0`.** (matchedV3TokenId is part of the match key, so a V3-token mismatch surfaces as presence divergence — no dead per-pair check.) Gates: `shadow-diff.test.ts` 12/12 (+5), api **998/998**, tsc 0 new. This makes the flip trustworthy and is exactly the parity bar B3-full/B4 must clear before serving.

---

## EPIC C — Cross-user anomaly detector

A scheduled sweep over each account's latest `portfolio_snapshots.metrics` (and, post-port, canonical positions) that writes findings into `anomaly_flags`. Mirrors the `payment-monitor` pattern: **one recurring BullMQ scan job, concurrency 1**, NOT a per-account fan-out and NOT folded into `portfolio-refresh` (credit-spend hot path). Reads already-persisted snapshots → adds no latency to refresh.

> **⚙️ C1 BUILT + КРИТИЧЕСКАЯ НАХОДКА о sequencing (2026-05-31).** `apps/api/src/modules/anomaly/checks.ts` — 4 чистых metrics-чека (start_zero_nonzero_value, pnl_pct_out_of_band, pnl_impossible_negative, cost_basis_error_present) + thresholds + `runMetricsChecks`. Тест `checks.test.ts` **15/15**. **НО dry-run по реальным снапшотам вскрыл:** из 1766 снапшотов с numeric startUsdEffective только **1** имел >0 (один раз 2026-05-12). **Серверные `portfolio_snapshots.metrics` НЕ содержат cost basis** — он считается КЛИЕНТСКИ (сервер гоняет только упрощённый drifted WAC). → 3 из 4 C1-чеков (всё что зависит от startUsdEffective/pnlOwnPct/pnlOwnUsd) на текущих снапшотах дают **all-trip шум** (все аккаунты «start~$0 + value большой»), а не сигнал. **Вывод (пересмотр sequencing):** cost-basis/PnL чеки = фактически **POST-port** (нужны canonical positions из `ucb_shadow_results` B5), НЕ pre-port. Чистые функции верны и переиспользуемы post-port. **Pre-port ценность детектора = чеки, НЕ требующие cost basis:** `duplicate_op_divergent_pricing` (подтверждённый баг: 25% tx дублированы, до 25.9% расхождения — из `chain_operations`), `upstream_service_unavailable` (Krystal/DeBank 503 из `api_usage`), `stale_snapshot`, `refresh_errors_persisted`. **NEXT для детектора: строить registry/availability-чеки (C5b subset), а cost-basis/PnL чеки держать для post-port (C7–C8).** C1 функции готовы, ждут B5.

> **⚙️ C5b `duplicate_op_divergent_pricing` BUILT + validated on real data (2026-06-01).** `apps/api/src/modules/anomaly/registry_checks.ts` — чистая `findDivergentDuplicatePricing(records, {warnPct:0.01, errorPct:0.05, minUsd:1})`: группирует op-rows по `(chain,tx_hash,log_index)`, флагает группы где spread `(max−min)/max` по Σ\|movement.usd\| превышает порог + ≥2 distinct wallets. Тест `registry_checks.test.ts` **7/7** (api anomaly суммарно **22/22**). **Real-data dry-run (SQL по chain_operations, все аккаунты):** 144 dup-группы (≥2 кошелька), **31 расходятся >1%, 0 >5%, max 4.4%, 125 cross-account.** **Находка:** топ-расхождения кластеризуются на **~4.34–4.37% (равномерно!)** — это НЕ случайный per-tx шум, а **систематический cross-account offset** (два аккаунта делят один адрес, синкнуты в разное время → у каждого все ops priced под цену своего синка → равномерный сдвиг). Подтверждает sync-time-pricing баг (движок-инвариант: цена не должна зависеть от времени синка). Магнитуда сейчас НИЖЕ задокументированной 25.9% (2026-05-31) — потому что синки ближе по времени; магнитуда = функция от разрыва синков, **что и есть причина чинить через block-fixed pricing (B1)**. Порог error=5% корректно молчит сегодня (max 4.4%), но сработал бы на пике 25.9%. **WIRED (2026-06-01): вшит в admin-tech-audit как checker `duplicateOpDivergentPricing` → отображается на админ-странице «Тех. аудит»** (SQL-группировка, пороги из общего `DUPLICATE_PRICING_DEFAULTS` — pure-функция и checker не разъезжаются; LIMIT 50 по spread). End-to-end проверено: страница покажет **31 finding (все warning, все cross-account; 0 error т.к. max 4.4%<5%)**. tsc clean, anomaly unit 22/22. Pure `findDivergentDuplicatePricing` остаётся как tested-spec для будущего Epic-C BullMQ-пути (post-port persistence).

> **⚙️ C5b `upstream_service_unavailable` — усилил СУЩЕСТВУЮЩИЙ admin-tech-audit (2026-06-01).** Находка: детектор upstream-ошибок УЖЕ существует — `apps/api/src/modules/admin-tech-audit/admin-tech-audit.service.ts::recentUpstreamErrors`, отображается на админ-странице **«Тех. аудит»** (`apps/web/src/pages/admin/TechAuditPage.tsx`, requireAdmin, рендер категорий generic). Был примитивен (любая ошибка ≥5/24ч = warning). **Усилил методологией C5b:** разбивка по `http_status`, severity по режиму отказа — **missing_api_key/503/402/403 → error** («данные сервиса ТИХО пропадают»), 429 → warning («прерывисто, то есть то нет»), для Krystal при error добавляется нота «LP fee/APR/cost basis могут ТИХО отсутствовать (POS-004/005)». Категория `upstream-service-unavailable`. **Validated на реальном api_usage (24ч):** 6 находок — **`upstream:krystal` 503×155 missing_key → ERROR** (ровно root cause POS-004/005, теперь авто-ловится), krystal/alchemy/etherscan/debank 429 → warn, debank 403 → error. tsc clean (api baseline-ошибки только в auth/cex тестах, не мои). Web-правок не нужно (generic category render). **Урок: pre-port детектор = admin-tech-audit framework (on-demand SQL→Finding[]→админ-страница), НЕ обязательно тяжёлый BullMQ+anomaly_flags путь Epic C.** Duplicate-pricing check тоже можно вшить сюда как checker (предложено owner). Тест: SQL-checker'ы здесь без юнит-тестов (паттерн файла); severity-логику можно вынести в чистый `classifyUpstreamFailure` + unit-тест (follow-up).

### Stage C1 — Pure check catalog (pre-port subset A1–A4)
- `apps/api/src/modules/anomaly/checks.ts` — **pure functions** (no DB/side effects), tunable thresholds at top. First four metrics-only checks returning `AnomalyFinding[]`:
  - `start_zero_nonzero_value` (`startUsdEffective < $1` AND `ownCapitalUsd > $500`) — error
  - `pnl_pct_out_of_band` (`pnlOwnPct < -100` → error, else `> 1000` → warn)
  - `pnl_impossible_negative` (`pnlOwnUsd < -startUsdEffective` by >1%) — error
  - `cost_basis_error_present` (`metrics.costBasisError` set) — warn

**✅ Test (local).** Vitest over hand-built `metrics` fixtures. No DB.

### Stage C2 — Service skeleton + dry-run reader
- `anomaly-detector.service.ts`: `scan()` loops `accountsRepo.findAllActive()` + `portfolioRepo.latestSnapshot()` per account with bounded concurrency (`ANOMALY_ACCOUNT_CONCURRENCY = 4`, R6), runs C1 checks, **logs findings (no writes yet)**.
- **Per-user isolation (risk R8):** every read scoped to the account; new repo methods take `walletIds`/`userId`; review rule: no `chain_operations` select without a wallet/account predicate.

**✅ Test (local).** Run against local DB with bob; assert logs list expected findings; zero external calls.

### Stage C3 — `anomaly_flags` write path + idempotency
- Repo upsert on `(account_id, wallet_id, check_id)`. Re-run bumps `last_seen_at` + refreshes `detail`; never duplicates. Flags no longer tripping auto-resolved (`status='resolved'`) by diffing currently-tripping keys vs open flags **in one transaction per account**.

**✅ Test (local).** Scan bob twice → identical row count, `last_seen_at` advanced (R7 idempotency); clear an anomaly → re-run → that flag auto-resolved.

**🚀 Promote to prod.** Gate: A1 live; CI green; no scheduler yet (manual only).

### Stage C4 — BullMQ queue + worker wiring
- `anomaly-detect.queue.ts` (`scheduleRecurring` via `upsertJobScheduler`, `enqueueManual()` with `jobId: manual-<unixSeconds>`), cloned from `payment-monitor.queue.ts`. Wire into `worker.ts` (`concurrency: 1`, `everyMs = 6h`). Admin `POST /admin/anomaly/scan`.

**✅ Test (local).** Boot worker vs local Redis; one scheduler id (re-boot → still one); manual route → one job writes flags.

**🚀 Promote to prod.** Gate: worker env present; CI green; manual route admin-guarded.

### Stage C5 — Remaining pre-port checks A5–A10
- `coverage_hole_ops` (ops==0 AND ownCapital>$1000), `cost_basis_exceeds_value` (per-symbol totalPaid > N× current; N≥50 → error), `position_no_matching_op`, `stale_snapshot` (latest > 3× cadence), `refresh_errors_persisted` (non-empty `errors[]` ≥2 consecutive), `near_zero_position_guard` (assetUsd > $100 but priced supply < $1 — the **POS-011 local symptom**) — error.

**✅ Test (local).** Fixtures reproducing POS-011 near-zero + $1000-position-zero-ops; assert `check_id` + severity.

### Stage C5b — LP / data-source checks (правила из опыта 2026-05-31)

Новый набор проверок, выведенных из реальных инцидентов сессии 2026-05-31
(Krystal-инцидент POS-004/005, base /transactions gap, Velodrome gauge, POS-012).
Привязка к [[capflow_data_source_authority]] + `notes/golden/knowledge-base.md`.
Помечены `pre` (на snapshot-метриках сейчас) / `post` (нужен server-side Krystal /
canonical после порта).

| check_id | условие | severity | phase | инцидент-источник |
|---|---|---|---|---|
| `fee_apr_without_fee` | `feeAprLifetime > 0` И `feesLifetimeUsd ≈ 0` (\|fee\|<$0.01) — или наоборот | error | pre | POS-004/005: Fee=«—» но APR 10.87% (stale после Krystal 503) |
| `upstream_service_unavailable` | провайдер (Krystal/DeBank/Etherscan/Alchemy) вернул 503/`missing_api_key`/persistent-error ≥1 в окне | error | pre | КОРЕНЬ инцидента: нет `KRYSTAL_API_KEY` → 503 → LP fee тихо пропали. Этот meta-чек поймал бы всё |
| `lp_not_sourced_from_krystal` | LP-позиция протокола В ПОКРЫТИИ Krystal, но метрики НЕ из Krystal (fell back to DeBank/Etherscan) | warn | post | locked decision: covered-LP обязан быть Krystal; fallback = Krystal недоступен |
| `lp_krystal_divergence` | covered-LP: \|наш startUsd − Krystal `depositTotalUsd`\| или \|current − `currentPositionValue`\| или \|fee − `tradingFee`\| > max($1, 0.5%) | warn→error | post | требование «точь-в-точь Krystal» — ловит дрейф |
| `claimed_fallback_divergence` | claimed взят из нашего реестра (Krystal `/transactions` пуст) И расходится с Krystal `/positions.tradingFee.claimed` > порога | info/warn | post | POS-004 base: Krystal /tx пуст → fallback; покрытие Krystal /tx не 100% |
| `engine_trace_incomplete` | `derivation.engineTraced == false` ИЛИ `uncoveredAmount > 0` (cost-basis lot-trace не покрыл amount) | warn | pre | POS-012: 0.009 ETH непокрыто → fallback-цена, неполный провенанс |
| `lp_uncovered_nearzero` | LP НЕ отдан Krystal (gauge-staked / вне покрытия) И `startUsd < $1` или `coverageIncomplete` | error | pre | Velodrome NFT 3427422: прод фейк $20.39 / локал $0 вместо $237.80 — plausible-fake |
| `stable_avgprice_off` | токен `isStable=true`, но \|`avgBuyPrice` − $1\| > 5% (или EUR-stable вне DefiLlama-коридора) | info | pre | GMX per-token split артефакт (USDC $0.57/$0.82) — внутренний, но сигнал |
| `lp_value_onchain_mismatch` | V3 `currentUsd` (DeBank) расходится с on-chain amounts (Alchemy `amount0/1Current`) > 5% | error | post | DeBank свопает amounts между NFT одного пула → fake PnL (Phase J канарейка) |
| `lot_methodology_not_applied` | multi-lot lending startUsd ИДЕНТИЧЕН для FIFO/LIFO/WAC (методика не применилась) | warn | pre | фикс 2026-05-31: `methodology` был хардкод "WAC" в buildOne:2366 → toggle не работал |
| `display_lottrace_divergence` | display startUsd ≠ `derivation.tokenTraces.totalCostUsd` для той же методики > max($1,1%) | warn | pre | POS-005: display $12.2k (cycleDeposit) vs WAC-trace $15.3k — display не из lot-trace |
| `partial_coverage_unguarded` | `lotConsumed.amount / supplied < 50%` (частичное покрытие истории) И НЕ `coverageIncomplete` (kind≠V3-LP) | error | pre | разрыв M6: coverageIncomplete только для V3-orphan; lending/staking 3-из-10-ETH → startUsd занижен, PnL раздут |
| `duplicate_op_divergent_pricing` | одна `(chain,tx_hash,log_index)` → >1 строка с расхождением movement-usd > 1% | error | pre | **CONFIRMED 2026-05-31: 560/2260 tx (25%) shared across wallets, 531 cross-account; 156 расходятся >1%, 26 >5%, max 25.9%.** Один on-chain tx priced sync-time → недетерминизм cost basis (POS-005) |
| `swap_movement_imbalance` | swap: \|out-usd − in-usd\| / max > 20% | warn | pre | 0xe99d6063: USDC out $12k vs ETH in $5.6k (2×) — неполное/искажённое движение |

**Дизайн-принципы (из опыта):**
1. **Meta-чек `upstream_service_unavailable` — приоритет №1:** большинство «тихих» LP-аномалий = недоступный источник (503/нет ключа), а не ошибка расчёта. Ловить причину, не симптом.
2. **Не маскировать отсутствие источника нулём** — флагить как сигнал «источник недоступен», а не показывать 0/stale (анти-паттерн #1).
3. **Divergence-чеки = «точь-в-точь Krystal» в исполнении:** detector сверяет covered-LP с Krystal и трипает при дрейфе → автоматический enforcement locked-decision.
4. Резолв аномалии → promote в golden (learning loop A3).

**✅ Test (local).** Fixtures: (a) feeApr>0 + fee=0 → `fee_apr_without_fee`; (b) Krystal 503 mock → `upstream_service_unavailable`; (c) engineTraced=false → `engine_trace_incomplete`; (d) gauge-NFT startUsd~0 → `lp_uncovered_nearzero`.

### Stage C6 — SQL report (cheapest surface, before any UI)
- Grouped-summary + top-offenders queries over `anomaly_flags` via `mcp__postgres__query`/psql. Tune `checks.ts` thresholds against signal/noise before any frontend.

**✅ Test (local).** Eyeball the report on bob; confirm acceptable false-positive rate.

### Stage C7 — Post-port phase gate + canonical drift B1 (gated on B5)
- Behind `UCB_PORTED` flag (default OFF). `canonical_vs_legacy_drift`: feed canonical `startUsd` (from `ucb_shadow_results`) alongside legacy `startUsdEffective`; flag abs %diff >30% AND abs $diff >$100 (>100% → error).

**✅ Test (local).** Flag OFF → no B-checks; flag ON with 40%-diff fixture → one drift flag.

### Stage C8 — Golden cross-reference B2 + anchors B3–B6 (gated on A3 + B5)
- `golden_case_drift` (**error, strongest signal**): for each `golden_cases` row, locate the matching canonical position, compute drift vs expected; beyond `tolerancePct` → error with `goldenCaseId` + `detail={expected,computed,driftPct}`. Natural CI/deploy gate candidate.
- Anchor checks: `eur_stable_mispriced` (within 0.5% of $1 → warn), `wrapped_alias_double_count`, `wac_at_null_fallback` (C11), `v3_startusd_unmatched` (pro-rata fallback AND netUsd>$1000).

**✅ Test (local).** Seed POS-011 golden ($237.80) + canonical fixture computing $20.40 → one error flag with `goldenCaseId` + correct `driftPct`; per-anchor fixtures for B3–B6.

### Stage C9 — Admin "Тех. аудит" page (last)
- **Admin-only (Q6).** Frontend table over `anomaly_flags` (`status='open'`, severity desc) with ack/resolve, plus **anomaly inbox + "Promote to golden"** (`POST /anomalies/:id/promote` → mints a `golden_cases` row → next replay run includes it). "Mark as golden" button on `/positions/:id` renders **only for admins** — regular users see no golden/anomaly affordances at all.

**✅ Test (local).** Admin login local web; view page; ack a flag → flips off open list; mark POS-011 golden → DB row + committed fixture appear; promote a resolved anomaly → new golden case + bidirectional link + next replay-test run includes it.

**🚀 Promote to prod.** Gate: report validated over several sweeps; admin-role-gated; CI green.

---

## Testing matrix (L1–L5)

| Layer | What | Tooling | Lives in | Used by |
|---|---|---|---|---|
| **L1 Unit (pure, offline)** | classifier/override/math, no I/O | `vitest run`, `vi.fn()` fetch mock, `makeFakeDb()` | `apps/{api,web}/src/**` next to source | every stage |
| **L2 Golden replay (offline)** | full UCB pipeline over frozen ops + frozen `histPrices`, assert `startUsd`/PnL to fixed value | `vitest run` over committed JSON | `apps/web/src/lib/portfolio/*.integration.test.ts` | **acceptance gate** for any cost-basis change |
| **L3 Integration (worker + real local DB)** | BullMQ processor vs dockerized dev Postgres; rows + idempotent upsert + bounded concurrency + completes under wall-clock cap | `vitest` `*.db.test.ts` env-gated, or `tsx` | `apps/api/src/modules/**/*.db.test.ts` | B1–B4 writers, C3 |
| **L4 Shadow-diff (server vs client)** | server value vs client UCB value, same wallet, \|Δ\| ≤ tolerance | `tsx` script + `dual_pipeline_equivalence.test.ts` template | `apps/api/src/scripts/shadow-diff-<epic>.ts` | every client→server move; B5 keystone |
| **L5 Manual local verification** | eyeball the real number for bob on the local stack | `pnpm dev` + dev compose + `healthcheck.sh` | n/a | final check per stage |

**Tolerances.** Default 5%; tighten to **absolute-dollar for cost-basis anchors** (POS-011 ~$237.80, not "within 5%"); B5 keystone = exact cost basis, ±$0.01 float epsilon.

**Offline determinism.** Capture-once-commit-replay (classifier output / Etherscan logs / slot0 frozen as JSON under `__fixtures__/golden/`); pass a fixed `histPrices: Map`; server tests mock `globalThis.fetch`; only real infra in L3/L4 is the **local dockerized** Postgres/Redis.

**CI additions.** Add: (1) an **L3 job** with `services: { postgres:16-alpine, redis:7-alpine }`, `pnpm db:migrate` + golden seed + `vitest run` only `*.db.test.ts` (tagged so default L1 stays DB-free); (2) a **shadow-diff check** non-blocking early, promoted to blocking once tolerances are trusted (`golden_case_drift` is the natural gate); (3) a **grep lint** failing CI if any non-`*.db.test.ts` contains a real URL outside a `vi.fn()` mock.

---

## Promotion-gate checklist (ALL must pass per stage before merge → `main`)

- [ ] **L1 + L2 green in CI**; the golden replay test for the incident this stage addresses is committed and green.
- [ ] **L4 shadow-diff within tolerance** for bob (and golden anchors) on the local stack; diff output pasted in the PR.
- [ ] **L3 idempotency + boundedness proven**: re-run writes no dupes; job completes under a wall-clock cap with bounded external-call concurrency (POS-024).
- [ ] **Migration additive only** (new table / nullable column / new index — no destructive change on a populated table). Reversible by pre-deploy `pg_dump` + code-only `rollback.yml`. Shared reference tables carry **no `user_id`**; user-scoped carry `account_id`/`wallet_id`. **Migration applied on prod DB BEFORE the code that reads it.**
- [ ] **Feature flag default OFF** (resolver precedence user→account→global→default:false). Prod ships dark even if L4 was wrong.
- [ ] **Rollout plan stated**: self → beta → `global=true`; never flip global on the same PR that adds the code.
- [ ] **Env keys provisioned on the server FIRST** (`ETHERSCAN_API_KEY`, `KRYSTAL_API_KEY`, `DEFILLAMA_BASE_URL`) in `/opt/cap-flow/.env`, present on the **worker** container (`docker compose exec worker env | grep …`), added to `.env.example` in the same PR. #1 prod≠local cause is "deploy didn't deliver the config."
- [ ] **Caddy/route changes verified to reach disk** if a route was added (`compose run --rm caddy validate`; Caddyfile/`docker-compose.yml` edits in the same PR, since they ship via scp not the image).
- [ ] **Kill switch wired**: a flag toggle reverts to the client/legacy path without a redeploy; rollback runbook includes the targeted poisoned-cache `DELETE … WHERE source=… AND fetched_at > <deploy_ts>`.

Tests green prove the **code**; the last three boxes prove the **environment** will deliver it.

---

## Q&A decisions (2026-05-30)

**Q1 — Existing user positions are never touched until the flagged flip.** B1–B4 are cache-fill only (no served output), B5 is shadow only (computes `ucb_shadow_results`, does not display), B6 is the only stage that changes the UI and it is behind the per-user `ucbServerCanonical` flag with the client recompute path kept permanently as fallback. "Migrating users onto server UCB rails" = ramping the B6 flag (internal → beta → wider) only after shadow-diff is zero for ≥2 weeks. Kill switch reverts without redeploy.

**Q2 — API volume.** The port concentrates all users' external calls onto single shared keys. Priority for paid upgrades: (1) **Etherscan** — almost certainly; current FREE tier (3/s, 100k/day) is the bottleneck for V3 events (B3) + lending/opener (B4) across all users; backfill will blow the daily cap. (2) **DefiLlama** — likely during backfill (B1 op pricing). (3) **Alchemy** — possible backfill spike (V3 positions/slot0). (4) **Krystal** — watch credit budget. (5) **DeBank** — no new load (reuses existing snapshots). Shared-cache makes load a one-time backfill spike, then cheap incremental steady-state. Bounded concurrency on FREE tier just makes backfill *slow* (days), not unsafe — upgrades buy throughput. **Instrument first:** run B1+B3 backfill for bob + 2-3 golden accounts on current keys, read `api_usage`, then size upgrades by real numbers.

**Q3 — Golden is per-POSITION opt-in, not per-account.** `golden_cases` is keyed `(walletId, positionId/marketKey)`. You mark only positions you have personally verified; unmarked positions on the same account are **"unverified", not "wrong"**. The detector must distinguish three states and NEVER flag a position as broken merely because it differs from legacy when no golden exists:
- **golden-confirmed** — a `golden_cases` row exists → drift beyond tolerance = high-severity error.
- **anomaly** — a heuristic tripped → `status='open'`, human reviews.
- **unverified/unknown** — neither golden nor a tripped heuristic → silent (no flag).
Partial golden coverage is the normal working mode; mark positions golden incrementally as you work through them.

**Q5 — Commit / rollout strategy (DECIDED 2026-05-30).** Do NOT commit accumulated work yet. First stand up a **dedicated, brand-new test account** (separate from real users) and verify the full UCB chain works correctly on it end-to-end. Only once that test account is green do we commit, then roll out to other users (the B6 per-user flag ramp). Until then, A0–A5 work accumulates in the worktree uncommitted. The dedicated test account becomes the primary golden-anchor source (curate its positions, mark them golden, replay them).

**Q6 — golden_cases + anomaly_flags are ADMIN-ONLY (DECIDED 2026-05-30).** Marking/viewing golden cases and viewing/managing anomaly flags is an **admin-only** capability. A regular (non-admin) user:
- canNOT mark positions golden, cannot see any "Mark as golden" affordance, cannot list/read golden cases or anomalies;
- sees their app exactly as today — the positions UI is unchanged, no new badges/inboxes.
Implications threaded into the stages:
- **A3 (Golden API):** every golden-cases + anomalies endpoint sits behind the **admin role guard** (not the per-user owner guard). The `walletId`/`accountId` on a row identify the *subject* the admin is curating (any user's wallet, incl. the test account), not an owner who may edit. Write path = admin only; there is no user-facing golden/anomaly surface.
- **C9 (Тех. аудит page + "Promote to golden"):** admin-only page (already implied) — and the "Mark as golden" button on `/positions/:id` is rendered ONLY for admins.
- The detector (Epic C) still runs across all users' snapshots, but its findings are visible only to admins.

**Q4 — Skeptic (adversarial-verify) agents are wired into per-stage workflows.** After a stage's golden tests pass, spawn independent skeptics tasked to REFUTE parity (find inputs where server ≠ client, or cost basis drifts) — especially on B5: float-determinism, lot-consume ordering, failed-tx, EUR-stables, wrapped-aliasing. A confirmed skeptic finding becomes a new golden case (closes the 3× recurrence loop).

## Golden case authoring & methodology-memory process (durable — never forgotten)

When an operator designates a position as golden/reference, we capture not just the *expected number* but the **derivation process and the rule it establishes**, persisted in THREE durable layers so the knowledge survives across sessions, the server UCB port, and every other position-accounting path. A golden case that records only `expectedStartUsd` is insufficient — the *why* and *how* must outlive the person who found it.

**The ritual (every golden designation runs all of it):**
1. **Mark** — operator clicks "Mark as golden" on `/positions/:id` (or `POST /golden-cases`).
2. **Freeze inputs** — system serializes the exact input set the engine consumed (ops + the specific historical prices/events + annotations) into a committed fixture `__fixtures__/golden/<label>.json` (offline-replayable).
3. **Write the derivation note** — operator records, in `golden_cases.provenanceNote` (structured), HOW ground truth was established: the source-of-truth channel (`sourceOfTruth`), the exact steps (e.g. POS-011: `live → ownerOf(gauge) → NFT 3427422 → mint tx → DefiLlama price at block → $237.80`), and **which methodology invariant (M1–M6) the case exercises** (LP vs non-LP, the coverage tier, the fallback level hit). This ties the number to the *rule*, not just the value.
4. **Persist in three layers:**
   - **DB** (`golden_cases`, per-user) — the live oracle the detector checks against.
   - **Repo** — the committed fixture **plus an append-only ledger entry** in `notes/golden/<label>.md` (code-reviewed, durable, diff-able): the derivation note + the general rule established. This is the canonical, human-readable record.
   - **Agent memory** — a one-line pointer in the memory index so future sessions reload "this position-type is computed this way and here is the proven anchor." New rules/incidents update the relevant `capflow_*` memory (e.g. velodrome gauge backlog, V3 cost basis), never duplicated.
5. **Bind to tests** — the fixture is auto-picked-up by `golden_cases.replay.test.ts`; the rule is now enforced in CI forever (the 3× recurrence loop closes).
6. **Versioning** — `methodologyVersion` stamps the case; if the methodology changes, the note records why the expected value moved, so history is never silently overwritten.

**Why three layers (not one):** DB is queryable but per-environment and can be reset; the repo ledger is the durable code-reviewed source of truth and survives DB resets; agent memory guarantees the knowledge is *reloaded into context automatically* every session so it is never re-derived from scratch or forgotten. The server UCB port and any other accounting path read the same committed fixtures, so the rule is one source enforced everywhere.

**Port implication:** A3 (Golden API) must write all three layers, not just the DB row. `notes/golden/` is created as the canonical ledger directory; the `POST /golden-cases` handler commits the fixture + a ledger stub; the operator fills the derivation note; a memory pointer is added for any case that establishes a new general rule.

---

## Methodology invariants the port MUST preserve (2026-05-30)

Grounded in the current client (`open_positions.ts`, `position_lot_cost_basis.ts`, `position_coverage.ts`, `lot_tracker.ts`, `krystal/override.ts`). The server engine must reproduce these exactly.

**M1 — Two independent numbers per position.**
- `currentUsd` = **live spot**, never historical, never persisted as cost basis: DeBank `assetUsd` (V3: minus pending fees to avoid double-count, `open_positions.ts:2598`), Krystal `currentUsd`, Alchemy NFT. Updates every refresh.
- `startUsd` = **historical cost at entry**, fixed at open, from `wacAt(time)` / DefiLlama hist / flagged fallback. NEVER live spot (`m.usd`) — that is an explicit anti-recurrence warn.

**M2 — Which historical prices are persisted (`op_token_prices`).** Only discrete points at **acquisition-operation timestamps** (swap, fiat_buy, **transfer_in**), hourly buckets. Stables → $1. Current-value tokens are not priced historically. NOT a continuous series. **The port's B1 MUST price all acquisition ops including `transfer_in` times** (not just position-open ops) — otherwise the M3 fallback level 2 degrades and coverage drops.

**M3 — Non-LP (lending/staking) cost basis = lot methodology with a per-unit fallback hierarchy.** Supplied asset is consumed from the lot tracker by the user's FIFO/LIFO/WAC choice. The uncovered remainder is priced **per-unit, independently**, by hierarchy (`position_lot_cost_basis.ts:469–525`):
1. CEX cross-wallet inheritance override (transfer_in matched to a CEX withdrawal).
2. **Historical price at transfer-IN time** (when the asset arrived in the wallet) — a lot priced at arrival, NOT at position-open time.
3. Last resort: no price → lot NOT created → `uncoveredAmount` (cost $0), position flagged `coveragePct<100` + `fallbackUsd`/`coverageIncomplete`. Silent `m.usd` inflation is forbidden.
There is **no percentage threshold that switches logic** — `coveragePct` is a reporting aggregate, not a branch. `startUsd = Σ(known-lot cost) + Σ(uncovered × arrival-time price) + (unpriceable remainder → uncovered)`.

**M4 — LP (V3 and other) does NOT use FIFO/LIFO/WAC for startUsd.** Krystal `totalDepositValue` (deposit-time priced) → else token historical prices at entry time (`krystal/override.ts:135–170`, `v3_cost_basis_override.ts`). Deliberate contrast with M3.

**M6 — Coverage governs CONFIDENCE, not which methodology runs.** The FIFO/LIFO/WAC choice always applies to the known lots regardless of coverage %; low coverage changes how much of the position is cost-traced and how much is estimated, plus how the result is presented. Define two ratios (M3's per-unit pricing is unchanged):
- `trustedPct` = amount priced from **real acquisition cost** (buy/swap lots + CEX inheritance + LP-unwind). 
- `pricedPct` = `trustedPct` + amount priced by **arrival-time proxy** (transfer_in historical price — we know *when* it arrived, not what was paid; treat as estimate, not truth).
- remainder = `uncovered` (no price, $0).

Tiered behavior (thresholds tunable, default proposal — **confirm before coding**):
- **`trustedPct` ≥ 95%** → trusted: `startUsd`, PnL, feeApr shown normally.
- **50% ≤ `trustedPct` < 95%** → estimated: compute the same way (lots + arrival-time for the rest), but mark `coverageIncomplete`-adjacent "estimated" so the UI caveats PnL/APR; nothing suppressed.
- **`trustedPct` < 50%** → low-confidence: still compute `startUsd` from what's known + arrival-time, but **set `coverageIncomplete=true`, suppress derived metrics that low coverage makes misleading (feeApr, PnL%), label "cost basis incomplete," and route to manual annotation.** Never present a <50%-traced estimate as a confident number.

The correct escape hatch at low coverage is **manual annotation** (`chain_operation_annotations.manualCostBasisUsd`): the human supplies the truth, which then becomes a golden case (see authoring process below). **DECIDED (2026-05-30): arrival-time-priced transfer_ins count toward `pricedPct` ONLY, never `trustedPct`** — arrival-time is a proxy (the asset could be a gift or bought off-platform), so it must not inflate the trusted-coverage ratio that drives the confidence tiers. `trustedPct` = buy/swap lots + CEX inheritance + LP-unwind only. The tier thresholds (95% / 50%) are evaluated against `trustedPct`.

**M6 worked example (reference — uncovered is NOT fabricated).** Bob supplies 10 ETH to Aave; current ETH $3,000 → `currentUsd $30,000`. Reconstructed acquisition: 4 ETH from swaps (2@$1,500 + 2@$2,000 = $7,000, **trusted**); 3 ETH `transfer_in` priced at arrival $2,500 = $7,500 (**priced/proxy**); 3 ETH `transfer_in` with no price / coverage hole (**uncovered, $0**).
- `trustedPct = 40%` → LOW-CONFIDENCE. `startUsd = 7,000 + 7,500 + 0 = $14,500`. Naive PnL would be +$15,500/+107%, but ~$4,500 is phantom (3 ETH at $0 cost) → **suppress PnL%/feeApr, flag `coverageIncomplete`, route to manual annotation.** We do NOT invent a price for the uncovered 3 ETH.
- **Resolving the gap = promoting the chunk to trusted, two ways only:** (A) **fix the data** — discover the 3 uncovered ETH were a missed Binance withdrawal, fix CEX matching → inherit $2,200/ETH = $6,600 trusted → `startUsd $20,100`, `trustedPct 70%` → ESTIMATED tier, PnL +49% shown with caveat; or (B) **manual annotation** — operator sets `manualCostBasisUsd = $6,900` (Kraken statement) → trusted → `startUsd $21,400`, then mark golden (derivation note persisted in 3 layers).
- If neither A nor B is possible, the position stays low-confidence permanently: `startUsd` is an honest lower bound, derived metrics suppressed. Correct behavior — "incomplete" beats a fake +107%.

**🔒 M6 — РЕВИЗИЯ РЕШЕНИЯ (owner 2026-05-31), СУПЕРСЕДИТ «$0 remainder + suppress» выше:**
1. **Непокрытый остаток в ЛЮБОЙ lot-traced позиции → цена на момент ОТКРЫТИЯ позиции** (supply-op `lend_supply`/`lp_add` on-chain цена актива на блоке = `cycleDeposit.usd/cycleDeposit.amount`), а НЕ $0 и НЕ arrival-time. Помечается `pricedPct`/«оценено по входу», НЕ идёт в `trustedPct`. Так нет дыр $0, и для неизвестной части PnL считается «с момента открытия».
2. **НЕ гасим PnX%/feeApr.** Считаем по формуле всегда. `trustedPct` — только репортинг-ярлык доверия («N% оценено по цене входа»), НЕ переключает логику и НЕ суприссит метрики. Даже при 0% прослеженных покупок startUsd = стоимость на момент открытия (полностью pricedPct).
3. **Формула (заменяет строку 529):**
   `startUsd = Σ(covered lots cost — FIFO/LIFO/WAC, trusted) + uncovered_amount × open_time_price (pricedPct)`
   где `open_time_price = cycleDeposit.usd / cycleDeposit.amount` (supply-op), `uncovered_amount = supplied − covered`. `startAmount = полный supplied` (не только covered).
4. `trustedPct = covered/supplied` (истинный cost basis); `pricedPct = 100%` всегда (open-time доступна). Совместимо с анти-паттерном #1: open-time = historical-at-op (не тихий current-spot), явно помечена как оценка. Manual annotation по-прежнему промоутит pricedPct→trustedPct.
5. **Worked example (новая методика)** — 10 ETH в Aave, открыто при ETH **$2 500**, сейчас ETH $3 000 (`currentUsd $30 000`), прослежено 3 ETH (2@$1 200 + 1@$1 800 = $4 200 trusted, WAC $1 400):
   - covered 3 ETH (trusted) = **$4 200**; uncovered 7 ETH × open $2 500 = **$17 500** (priced);
   - **startUsd = $21 700**, `trustedPct 30%`, `pricedPct 100%`, startAmount 10 ETH;
   - **PnL = $30 000 − $21 700 = +$8 300 (+38.2%) — ПОКАЗЫВАЕТСЯ** (не гасим), ярлык «70% оценено по цене входа $2 500».
6. **Реализация** (`open_positions.ts buildOne`): сейчас при частичном покрытии `startUsd = lotConsumed.usd` (только covered) → заменить на `lotConsumed.usd + (supplied − lotConsumed.amount) × (cycleDeposit.usd/cycleDeposit.amount)`; `startAmount = supplied`; вычислять+экспонировать `trustedPct`; убрать suppress для lending (оставить ярлык). V3-orphan coverageIncomplete остаётся (там нет supply-op цены).

**M5 — Coverage/flags must round-trip through the port.** `coveragePct`, `fallbackUsd`, `coverageIncomplete`, `uncoveredAmount` are persisted into `ucb_shadow_results` and **compared in the shadow-diff** — matching `startUsd` alone is insufficient (server could reach the same number via a different coverage split). The anomaly detector reads `coveragePct`: low coverage + large net → flag for review (info <95%, warn <50%), **never "broken"** (the unverified state).

---

## Cross-cutting risk register

| # | Risk | Epics | Likelihood | Mitigation | Test |
|---|---|---|---|---|---|
| R1 | `historical_prices(symbol,date)` shared between FX codes (`EUR`,`GBP`) and crypto; `onConflictDoNothing` pins first-writer; EUR-stable vs EUR-fiat is a known prior bug | B | High | New `op_token_prices` keyed `(chain, token_id, hour_bucket)`; leave `historical_prices` to FX | Insert `EUR` via FX, run EUR-stable enrichment same date → two distinct rows |
| R2 | Server engine never validated vs client before flip | B,C | High | B5 shadow-diff; never flip until \|Δ\|~0; `/ucb/shadow-diff` | gate flip on max delta < tolerance |
| R3 | Copy-not-share drift (two `normalizeSymbol` already differ; 458-line classifier drift) | B | High | A0 extract shared `@cap-flow/ucb`; delete server copies; `drift_guard.test.ts` | same ops → identical per-symbol WAC incl. WBTC/BTC alias |
| R4 | `DISTANCE_TOLERANCE=0.01` + float pro-rata non-deterministic across engines | B,A | Med | port exact code/constant/accumulation order; round to cents at boundaries | byte-identical USD; re-run 100× stable |
| R5 | Caching cost basis during a feed outage (POS-024 recurrence) — shared row poisoned for all users | B,C | High | `priced_ok` flag; skip insert on failed/0 lookup | mock 503 → no row; restore → correct value |
| R6 | Etherscan FREE tier (3/s, 100k/day, one key) under multi-user enrichment | B | High | global token-bucket 3/s; per-day budget in `api_usage`; bounded concurrency; backoff; partial fail → `sync_error` | 50-wallet load ≤3/s; kill key → graceful |
| R7 | Shared-cache write race under worker `concurrency:5` | B | Med | immutable facts `onConflictDoNothing`; only per-wallet `chain_operations` upserts-update | two concurrent refreshes → one row |
| R8 | Multi-tenancy leak in a JOIN (new query forgets scope) | B,C | Med | every new repo method takes `walletIds`/`userId`; review rule | A & B share a `tx_hash`; A never sees B's rows |
| R9 | Annotation override precedence not enforced server-side | B | High | server engine joins `chain_operation_annotations`, applies excluded→drop / manualCostBasisUsd→override / manualOpType→reclassify before WAC | annotate bob op; server matches client |
| R10 | prod≠local deploy mechanics (scp inode-pin, Caddy validator without env, poisoned localStorage) | all | High | promotion checklist (migration-first, worker env present, flag OFF, bust localStorage cache version on schema change); validate via `compose run` | post-deploy `docker compose exec worker env`; flag OFF; bob refresh |
| R11 | Migration ordering / reversibility on live multi-user DB | all | Med | additive/nullable only; never alter `historical_prices` PK in place; backfill in a separate idempotent job | run migration on prod-snapshot copy; no long lock |
| R12 | C11 partial-lot `wacAt` not reproduced server-side | B | High | port the lot tracker wholesale via `@cap-flow/ucb` | lot fully consumed then re-bought → server `wacAt` matches client |
| R13 | Failed/reverted txs polluting cost basis | B,C | Med | centralize `status==="failed"` filter in the shared op-iterator | inject failed lp_add → $0 on both |
| R14 | Gauge-staked CL (POS-011) broken everywhere incl. prod | A,B | High | mandatory golden fixture asserting $237.80; preserve gauge-emissions-vs-fees guard | NFT 3427422 `startUsd≈$237.80` |
| R15 | bob alone can't cover the surface | A | High | curate ≥6 frozen golden accounts (V3 dedup, EUR-stable, gauge CL, lending, CEX, cross-wallet same-hash, Base→Krystal, Solana) | CI runs engine against all fixtures |
| R16 | No kill switch for the new server engine | all | Med | `ucbServerShadow`/`ucbServerCanonical` + one flag per detector; reads fall back when OFF | toggle OFF mid-incident → instant fallback |
| R17 | Rollback granularity (poisoned shared-cache rows outlive code rollback) | B | Med | tag writes `source`+`fetched_at`; targeted `DELETE … fetched_at > deploy_ts` | simulate bad backfill, roll back, cleanup DELETE |
| R18 | Observability gap — can't prove parity before flip | all | High | per-refresh shadow-diff metric to `api_usage`/audit; alert if non-zero on a canary | run bob + goldens 24h on canary; zero divergence |
