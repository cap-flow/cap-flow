/**
 * B6 slice 2 — client-side decision to ADOPT server-computed canonical positions.
 *
 * Pure core of the `useComputedPositions` server-canonical branch. The client
 * adopts the server result ONLY when every guard passes; otherwise it keeps its
 * own recompute (the permanent fallback, R16):
 *   1. per-user flag `capflow.feature.ucbServerCanonical` is ON,
 *   2. the server says `serve` (fresh shadow, no error — decided server-side),
 *   3. METHODOLOGY MATCH: the shadow's lotMethodology equals the user's current
 *      FIFO/LIFO/WAC toggle (a FIFO-computed shadow must not be shown to a LIFO
 *      user — this is what lets us skip server-side per-user methodology
 *      persistence for now),
 *   4. WALLET-SET MATCH: the two pipelines cover exactly the same wallets, so we
 *      never drop or add a wallet's positions by adopting (server = whole
 *      account, client = whatever's loaded in the browser).
 */
import { realWalletId } from "@cap-flow/ucb/identity";

/**
 * Structural shape of the GET /ucb/positions response we depend on. `positions`
 * is `unknown[]` (validated as opaque on the wire) — we read only `walletId`
 * off each, defensively.
 */
export interface ServePositionsResponse {
  serve: boolean;
  reason: string;
  positions: readonly unknown[] | null;
  lotMethodology: string | null;
}

function walletIdOf(p: unknown): string | null {
  if (typeof p !== "object" || p === null) return null;
  const w = (p as { walletId?: unknown }).walletId;
  return typeof w === "string" ? w : null;
}

/**
 * Defensive runtime check that a wire item has the CORE OpenPosition fields
 * every page reads (the GET response types positions as `unknown[]`). Guards the
 * `as OpenPosition[]` cast at the adoption site: if the server returns malformed
 * or partial data, we refuse to adopt and fall back to the client recompute.
 * NB: per-position-type fields (matchedV3TokenId, v3Details, …) are intentionally
 * NOT required here — those are validated by the shadow-diff parity gate before
 * the flip, not at adoption time.
 */
function isPlausiblePosition(p: unknown): boolean {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  const proto = o["protocol"] as Record<string, unknown> | undefined;
  return (
    typeof o["id"] === "string" &&
    typeof o["walletId"] === "string" &&
    typeof o["chain"] === "string" &&
    typeof o["startUsd"] === "number" &&
    typeof o["currentUsd"] === "number" &&
    typeof proto === "object" &&
    proto !== null &&
    typeof proto["id"] === "string" &&
    Array.isArray(o["supplyTokens"])
  );
}

/** Every served position must look like a real OpenPosition before we trust it. */
export function serverPositionsValid(positions: readonly unknown[]): boolean {
  return positions.length > 0 && positions.every(isPlausiblePosition);
}

/**
 * True when both pipelines reference the SAME set of wallets. Client position
 * walletIds are composite (`api:<uuid>:<addr>`) → reduce via realWalletId; server
 * walletIds are already the raw uuid.
 */
export function walletSetsEqual(
  clientPositions: readonly { walletId: string }[],
  serverPositions: readonly unknown[],
): boolean {
  const c = new Set(clientPositions.map((p) => realWalletId(p.walletId)));
  const s = new Set<string>();
  for (const p of serverPositions) {
    const w = walletIdOf(p);
    if (w) s.add(w);
  }
  if (c.size !== s.size) return false;
  for (const id of s) if (!c.has(id)) return false;
  return true;
}

export interface AdoptDecisionArgs {
  flagEnabled: boolean;
  resp: ServePositionsResponse | null | undefined;
  /** The user's current FIFO/LIFO/WAC toggle. */
  clientLotMethodology: string;
  /** The client's just-computed positions (fallback + wallet-set reference). */
  clientPositions: readonly { walletId: string }[];
  /**
   * `capflow.feature.ucbServerOnly`: браузер НЕ считает вообще (директива
   * owner 2026-06-12). В этом режиме clientPositions пуст по построению →
   * wallet-set guard пропускается; при не-served позиции НЕ пересчитываются
   * клиентом, а остаются пустыми с видимой причиной.
   */
  serverOnly?: boolean;
}

export function shouldAdoptServerPositions(args: AdoptDecisionArgs): boolean {
  const { flagEnabled, resp, clientLotMethodology, clientPositions } = args;
  if (!flagEnabled) return false;
  if (!resp || !resp.serve || !resp.positions) return false;
  if (resp.lotMethodology !== clientLotMethodology) return false;
  // Validate the wire payload before the `as OpenPosition[]` cast at the call site.
  if (!serverPositionsValid(resp.positions)) return false;
  return walletSetsEqual(clientPositions, resp.positions);
}

/** Откуда взяты показанные позиции + человекочитаемая причина (для UI-бейджа). */
export interface AdoptionVerdict {
  source: "server" | "client";
  /** Машинный код причины (для бейджа/телеметрии). */
  reason:
    | "served"
    | "flag_off"
    | "loading"
    | "methodology_mismatch"
    | "wallet_set_mismatch"
    | "invalid_payload"
    | "no_shadow"
    | "shadow_error"
    | "stale"
    | "not_served";
}

/**
 * Та же логика, что `shouldAdoptServerPositions`, но возвращает ПРИЧИНУ —
 * чтобы UI показывал «расчёт: сервер» / «расчёт: браузер (почему)» и тихий
 * клиентский пересчёт перестал быть невидимым (директива owner 2026-06-12:
 * «опираемся на сервер — он и должен выводить, не браузер»).
 */
export function describeAdoption(args: AdoptDecisionArgs): AdoptionVerdict {
  const { flagEnabled, resp, clientLotMethodology, clientPositions, serverOnly } =
    args;
  if (!flagEnabled) return { source: "client", reason: "flag_off" };
  if (!resp) return { source: "client", reason: "loading" };
  if (!resp.serve || !resp.positions) {
    // Сервер сам отказался отдавать — пробрасываем его причину, если она из
    // известного набора (ServeReason), иначе generic.
    const r = resp.reason;
    if (r === "no_shadow" || r === "shadow_error" || r === "stale")
      return { source: "client", reason: r };
    return { source: "client", reason: "not_served" };
  }
  if (resp.lotMethodology !== clientLotMethodology)
    return { source: "client", reason: "methodology_mismatch" };
  if (!serverPositionsValid(resp.positions))
    return { source: "client", reason: "invalid_payload" };
  // server-only: clientPositions пуст по построению (браузер не считал) —
  // wallet-set сверять не с чем, guard пропускается.
  if (!serverOnly && !walletSetsEqual(clientPositions, resp.positions))
    return { source: "client", reason: "wallet_set_mismatch" };
  return { source: "server", reason: "served" };
}

/**
 * Причины адопции, при которых в server-only режиме клиент должен дёрнуть
 * server-recompute (нет результата / он не подходит — но это ЧИНИТСЯ
 * пересчётом):
 *   - `no_shadow`   — НОВЫЙ аккаунт, воркер ещё не считал (инцидент moximko
 *                     2026-06-12: server-only выключил браузерный fallback →
 *                     пустая таблица навсегда без этого триггера);
 *   - `not_served`  — сервер по иной причине не отдал;
 *   - `methodology_mismatch` — тогл методики ≠ серверной;
 *   - `stale`       — снапшот свежее последнего shadow.
 * НЕ триггерим на `loading` (ответ ещё не пришёл), `flag_off`, `served`,
 * `invalid_payload`/`shadow_error` (пересчёт под той же методикой не починит —
 * нужен разбор, а не цикл).
 */
const RECOMPUTE_REASONS: ReadonlySet<string> = new Set([
  "no_shadow",
  "not_served",
  "methodology_mismatch",
  "stale",
]);

export function shouldServerRecompute(reason: string): boolean {
  return RECOMPUTE_REASONS.has(reason);
}
