/**
 * Krystal-absent V3 LP phantom filter.
 *
 * DeBank sometimes reports a V3 LP position that is actually CLOSED (residual
 * dust the live snapshot still shows) or that never really existed — neither is
 * a real open position, yet both render in /performance with misleading PnL.
 *
 * The reliable signal is Krystal's PRIMARY (open) position set: for a
 * Krystal-COVERED chain, a real open V3 LP is returned by Krystal. So a V3 LP
 * position that (a) our engine could not match to an on-chain NFT
 * (`matchedV3TokenId` is null) AND (b) Krystal does NOT list as open in that
 * pool — while Krystal IS returning open positions for that wallet — is a
 * phantom and should be hidden.
 *
 * Two phantom classes both caught here:
 *   - CLOSED-residual (Krystal lists the pool only as CLOSED): not in the open
 *     set → dropped.
 *   - Never-real / DeBank-only (Krystal has no record at all): not in the open
 *     set → dropped.
 *
 * SAFETY (never hide a real position):
 *   - Skipped entirely unless Krystal returned ≥1 open position for the wallet
 *     (fail-soft: Krystal down / unauth → filter no-ops).
 *   - Only chains Krystal covers (else a real position on an uncovered chain
 *     would look "absent").
 *   - Only positions WITHOUT a matched NFT — gauge-staked CL (POS-026) keep
 *     their `matchedV3TokenId` (we found the NFT on-chain) and are never touched,
 *     even though Krystal can't see them (owner = gauge).
 *   - Only small (`currentUsd < dustThreshold`) — defense-in-depth so a large
 *     position is never silently hidden on a Krystal indexing gap.
 */
import type { KrystalV3Summary } from "./adapter";

/** Chain codes Krystal Cloud indexes (krystal_cloud_api_reference §Chains). */
export const KRYSTAL_COVERED_CHAINS: ReadonlySet<string> = new Set([
  "eth",
  "op",
  "bsc",
  "matic",
  "base",
  "arb",
  "ron",
  "avax",
  "unichain",
  "hyperevm",
  "berachain",
  "sonic",
]);

export interface KrystalOpenIndex {
  /** `owner|chain|pool` (all lowercased) for every Krystal OPEN position. */
  readonly openPoolKeys: ReadonlySet<string>;
  /** Owner addresses (lowercased) with ≥1 Krystal OPEN position. */
  readonly activeWallets: ReadonlySet<string>;
}

/** Build the open-position index from the primary Krystal summaries. */
export function buildKrystalOpenIndex(
  summaries: Iterable<KrystalV3Summary>,
): KrystalOpenIndex {
  const openPoolKeys = new Set<string>();
  const activeWallets = new Set<string>();
  for (const s of summaries) {
    const owner = (s.ownerAddress ?? "").toLowerCase();
    const pool = (s.poolAddress ?? "").toLowerCase();
    const chain = (s.chainCode ?? "").toLowerCase();
    if (!owner || !pool || !chain) continue;
    openPoolKeys.add(`${owner}|${chain}|${pool}`);
    activeWallets.add(owner);
  }
  return { openPoolKeys, activeWallets };
}

export interface PhantomFilterResult<P> {
  positions: P[];
  dropped: P[];
}

/**
 * Drop Krystal-absent V3 LP phantoms. Returns kept + dropped (dropped exposed
 * for logging/diagnostics). Fail-soft no-op when Krystal returned nothing.
 */
export function filterKrystalAbsentV3Phantoms<
  P extends {
    walletId: string;
    chain: string;
    protocol: { name: string };
    matchedV3TokenId?: string;
    lpTokenId?: string;
    currentUsd: number;
  },
>(
  positions: readonly P[],
  walletAddressById: ReadonlyMap<string, string>,
  index: KrystalOpenIndex,
  isV3LpProtocol: (name: string) => boolean,
  dustThresholdUsd = 50,
): PhantomFilterResult<P> {
  if (index.activeWallets.size === 0) {
    return { positions: positions.slice(), dropped: [] };
  }
  const kept: P[] = [];
  const dropped: P[] = [];
  for (const p of positions) {
    const wallet = walletAddressById.get(p.walletId)?.toLowerCase();
    const candidate =
      isV3LpProtocol(p.protocol.name) &&
      !p.matchedV3TokenId &&
      !!p.lpTokenId &&
      p.currentUsd < dustThresholdUsd &&
      KRYSTAL_COVERED_CHAINS.has(p.chain.toLowerCase()) &&
      !!wallet &&
      index.activeWallets.has(wallet);
    if (!candidate) {
      kept.push(p);
      continue;
    }
    const key = `${wallet}|${p.chain.toLowerCase()}|${p.lpTokenId!.toLowerCase()}`;
    if (index.openPoolKeys.has(key)) {
      kept.push(p); // Krystal lists it open → real position
    } else {
      dropped.push(p); // covered chain + Krystal active + no NFT + not open → phantom
    }
  }
  return { positions: kept, dropped };
}
