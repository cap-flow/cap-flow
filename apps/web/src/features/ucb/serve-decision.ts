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
}

export function shouldAdoptServerPositions(args: AdoptDecisionArgs): boolean {
  const { flagEnabled, resp, clientLotMethodology, clientPositions } = args;
  if (!flagEnabled) return false;
  if (!resp || !resp.serve || !resp.positions) return false;
  if (resp.lotMethodology !== clientLotMethodology) return false;
  return walletSetsEqual(clientPositions, resp.positions);
}
