/**
 * A3.6 — STABLE, globally-unique position identity.
 *
 * The display id `POS-NNN` is assigned sequentially per render and RESHUFFLES
 * on every recompute — useless as a durable key (golden marks would attach to
 * the wrong position after a refresh). This derives a stable key from the
 * position's durable on-chain anchor instead:
 *
 *   walletId | chain | protocolId | (marketKey | openHash) | sortedSupplySymbols
 *
 * • `walletId` is a globally-unique wallet UUID (composite `api:<uuid>:<addr>`
 *   is reduced to the uuid), and every wallet maps to exactly one account
 *   (FK wallet→account), so the key is unique across ALL users' positions.
 * • `marketKey` (V3/GM/GLV NFT or vault addr) / `openHash` is the durable
 *   on-chain anchor; survives recompute.
 * • `sortedSupplySymbols` disambiguates legs that SHARE a marketKey (e.g. the
 *   ETH leg vs the WBTC leg of one Fluid vault are separate rows).
 *
 * This is the canonical per-position id for the cross-user knowledge base.
 */
export interface PositionIdentityInput {
  walletId: string;
  chain: string;
  protocol: { id: string };
  lpTokenId?: string | undefined;
  openHash?: string | null | undefined;
  supplyTokens: ReadonlyArray<{ symbol: string }>;
}

/** Reduce a composite frontend wallet id (`api:<uuid>:<addr>`) to the uuid. */
export function realWalletId(walletId: string): string {
  return walletId.startsWith("api:")
    ? (walletId.split(":")[1] ?? walletId)
    : walletId;
}

export function positionKey(p: PositionIdentityInput): string {
  const wallet = realWalletId(p.walletId);
  const anchor = p.lpTokenId || p.openHash || "x";
  const supply = [...p.supplyTokens.map((t) => t.symbol.toUpperCase())]
    .sort()
    .join("+");
  return `${wallet}|${p.chain}|${p.protocol.id}|${anchor}|${supply}`;
}
