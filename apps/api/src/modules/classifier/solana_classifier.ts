/**
 * Solana classifier — server port of
 * `apps/web/src/lib/portfolio/solana_classifier.ts` (P5.4).
 *
 * Convert raw Helius transactions → `ClassifiedOp[]` compatible with the
 * EVM branch and the cost-basis reducer. Output sorted oldest → newest.
 */

import type { HeliusTransaction } from "./helius_types.js";
import { isProtocolToken } from "./protocols.js";
import {
  SOL_NATIVE_MINT,
  classifySolSource,
  isSolCexAddress,
  isStableMint,
  priceForMint,
  symbolForMint,
} from "./spl_tokens.js";
import type { ClassifiedOp, OpType, TokenMovement } from "./types.js";

export interface SolanaClassifyContext {
  readonly selfAddress: string;
  readonly ownAddresses: Set<string>;
}

export function classifyHeliusHistory(
  raw: HeliusTransaction[],
  ctx: SolanaClassifyContext
): ClassifiedOp[] {
  const seen = new Set<string>();
  const unique = raw.filter((t) => {
    if (seen.has(t.signature)) return false;
    seen.add(t.signature);
    return true;
  });
  unique.sort((a, b) => a.timestamp - b.timestamp);
  return unique.map((t, i) => classifyOne(t, i + 1, ctx));
}

function classifyOne(
  tx: HeliusTransaction,
  seq: number,
  ctx: SolanaClassifyContext
): ClassifiedOp {
  const movement = buildMovements(tx, ctx.selfAddress);
  const protocol = classifySolSource(tx.source);
  const status: "ok" | "failed" = tx.transactionError ? "failed" : "ok";
  const gasUsd: number | null = null;

  if (status === "failed") {
    return base(tx, seq, "failed", protocol, movement, status, ctx, gasUsd);
  }

  const sends = movement.filter((m) => m.direction === "out");
  const receives = movement.filter((m) => m.direction === "in");

  // 1. CEX.
  const counterpartyAddr = pickCounterpartyAddress(tx, ctx.selfAddress);
  const cex = counterpartyAddr ? isSolCexAddress(counterpartyAddr) : null;
  if (cex) {
    if (sends.length === 0 && receives.length > 0) {
      return base(
        tx,
        seq,
        "deposit_fiat",
        protocol,
        movement,
        status,
        ctx,
        gasUsd,
        [`from CEX: ${cex.name}`]
      );
    }
    if (sends.length > 0 && receives.length === 0) {
      return base(
        tx,
        seq,
        "withdraw_fiat",
        protocol,
        movement,
        status,
        ctx,
        gasUsd,
        [`to CEX: ${cex.name}`]
      );
    }
  }

  // 2. Internal transfers between own wallets.
  const allParticipants = collectParticipants(tx);
  const otherSelf = allParticipants.find(
    (a) => a !== ctx.selfAddress && ctx.ownAddresses.has(a)
  );
  if (otherSelf && !protocol) {
    if (sends.length && !receives.length) {
      return base(
        tx,
        seq,
        "transfer_out",
        protocol,
        movement,
        status,
        ctx,
        gasUsd
      );
    }
    if (receives.length && !sends.length) {
      return base(
        tx,
        seq,
        "transfer_in",
        protocol,
        movement,
        status,
        ctx,
        gasUsd
      );
    }
  }

  // 3. Helius `type` — strongest signal.
  const type = (tx.type || "").toUpperCase();
  switch (type) {
    case "SWAP":
      return base(
        tx,
        seq,
        "swap",
        protocol ?? defaultDex(tx.source),
        movement,
        status,
        ctx,
        gasUsd
      );
    case "STAKE_SOL":
    case "STAKE":
    case "DELEGATE":
      return base(tx, seq, "stake", protocol, movement, status, ctx, gasUsd);
    case "UNSTAKE":
    case "UNDELEGATE":
    case "DEACTIVATE_STAKE":
    case "WITHDRAW":
      if (protocol?.category === "lending") {
        return base(
          tx,
          seq,
          "lend_withdraw",
          protocol,
          movement,
          status,
          ctx,
          gasUsd
        );
      }
      return base(tx, seq, "unstake", protocol, movement, status, ctx, gasUsd);
    case "DEPOSIT":
    case "DEPOSIT_FRACTIONAL_POOL":
      if (protocol?.category === "lending") {
        return base(
          tx,
          seq,
          "lend_supply",
          protocol,
          movement,
          status,
          ctx,
          gasUsd
        );
      }
      return base(tx, seq, "lp_add", protocol, movement, status, ctx, gasUsd);
    case "BORROW":
      return base(tx, seq, "borrow", protocol, movement, status, ctx, gasUsd);
    case "REPAY":
    case "REPAY_LOAN":
      return base(tx, seq, "repay", protocol, movement, status, ctx, gasUsd);
    case "ADD_LIQUIDITY":
      return base(tx, seq, "lp_add", protocol, movement, status, ctx, gasUsd);
    case "REMOVE_LIQUIDITY":
      return base(
        tx,
        seq,
        "lp_remove",
        protocol,
        movement,
        status,
        ctx,
        gasUsd
      );
    case "REWARD_CANCELED":
    case "CLAIM_REWARDS":
    case "CLAIM":
    case "CLAIM_TOKEN":
      return base(
        tx,
        seq,
        "claim_rewards",
        protocol,
        movement,
        status,
        ctx,
        gasUsd
      );
    case "TRANSFER":
      break;
  }

  // 4. Movement-direction heuristics per protocol category.
  if (protocol?.category === "lending" || protocol?.category === "cdp") {
    const sentProto = sends.some((s) => s.isProtocolToken);
    const recvProto = receives.some((r) => r.isProtocolToken);
    if (!sentProto && recvProto)
      return base(
        tx,
        seq,
        "lend_supply",
        protocol,
        movement,
        status,
        ctx,
        gasUsd
      );
    if (sentProto && !recvProto)
      return base(
        tx,
        seq,
        "lend_withdraw",
        protocol,
        movement,
        status,
        ctx,
        gasUsd
      );
    if (!sends.length && receives.length)
      return base(tx, seq, "borrow", protocol, movement, status, ctx, gasUsd);
    if (sends.length && !receives.length)
      return base(tx, seq, "repay", protocol, movement, status, ctx, gasUsd);
  }
  if (protocol?.category === "staking" || protocol?.category === "restaking") {
    if (receives.some((r) => isProtocolToken(r.symbol)))
      return base(tx, seq, "stake", protocol, movement, status, ctx, gasUsd);
    if (sends.some((s) => isProtocolToken(s.symbol)))
      return base(tx, seq, "unstake", protocol, movement, status, ctx, gasUsd);
  }
  if (protocol?.category === "perp" || protocol?.category === "yield") {
    if (sends.length && !receives.length)
      return base(tx, seq, "lp_add", protocol, movement, status, ctx, gasUsd);
    if (receives.length && !sends.length)
      return base(
        tx,
        seq,
        "lp_remove",
        protocol,
        movement,
        status,
        ctx,
        gasUsd
      );
    if (sends.length && receives.length)
      return base(tx, seq, "swap", protocol, movement, status, ctx, gasUsd);
  }
  if (protocol?.category === "bridge") {
    if (sends.length && !receives.length)
      return base(
        tx,
        seq,
        "bridge_out",
        protocol,
        movement,
        status,
        ctx,
        gasUsd
      );
    if (receives.length && !sends.length)
      return base(
        tx,
        seq,
        "bridge_in",
        protocol,
        movement,
        status,
        ctx,
        gasUsd
      );
  }

  // 5. Net-balance swap fallback (Jupiter/Raydium/Orca/DFlow multi-leg).
  if (sends.length > 0 && receives.length > 0) {
    const netByMint = new Map<string, number>();
    for (const m of sends) {
      netByMint.set(m.tokenId, (netByMint.get(m.tokenId) ?? 0) - m.amount);
    }
    for (const m of receives) {
      netByMint.set(m.tokenId, (netByMint.get(m.tokenId) ?? 0) + m.amount);
    }
    let hasNetIn = false;
    let hasNetOut = false;
    for (const v of netByMint.values()) {
      if (v > 1e-9) hasNetIn = true;
      else if (v < -1e-9) hasNetOut = true;
    }
    if (hasNetIn && hasNetOut) {
      return base(
        tx,
        seq,
        "swap",
        protocol ?? defaultDex(tx.source),
        movement,
        status,
        ctx,
        gasUsd,
        undefined,
        "auto"
      );
    }
  }

  // 6. Plain transfers.
  if (sends.length && !receives.length)
    return base(
      tx,
      seq,
      "transfer_out",
      protocol,
      movement,
      status,
      ctx,
      gasUsd
    );
  if (receives.length && !sends.length)
    return base(
      tx,
      seq,
      "transfer_in",
      protocol,
      movement,
      status,
      ctx,
      gasUsd
    );

  return base(tx, seq, "unknown", protocol, movement, status, ctx, gasUsd);
}

function buildMovements(
  tx: HeliusTransaction,
  self: string
): TokenMovement[] {
  const out: TokenMovement[] = [];

  for (const n of tx.nativeTransfers ?? []) {
    if (n.amount === 0) continue;
    const sol = n.amount / 1_000_000_000;
    if (n.fromUserAccount === self) {
      out.push(makeMov("out", SOL_NATIVE_MINT, "SOL", sol, false));
    } else if (n.toUserAccount === self) {
      out.push(makeMov("in", SOL_NATIVE_MINT, "SOL", sol, false));
    }
  }

  for (const t of tx.tokenTransfers ?? []) {
    if (!t.tokenAmount || !t.mint) continue;
    if (t.fromUserAccount === self) {
      out.push(
        makeMov(
          "out",
          t.mint,
          symbolForMint(t.mint),
          t.tokenAmount,
          isStableMint(t.mint)
        )
      );
    } else if (t.toUserAccount === self) {
      out.push(
        makeMov(
          "in",
          t.mint,
          symbolForMint(t.mint),
          t.tokenAmount,
          isStableMint(t.mint)
        )
      );
    }
  }

  return out;
}

function makeMov(
  direction: "in" | "out",
  mint: string,
  symbol: string,
  amount: number,
  isStable: boolean
): TokenMovement {
  const usd = priceForMint(mint, amount);
  return {
    direction,
    symbol,
    tokenId: mint,
    amount,
    usd,
    isStable,
    isProtocolToken:
      isProtocolToken(symbol) ||
      (/SOL$/i.test(symbol) === false && symbol.startsWith("k")),
  };
}

function pickCounterpartyAddress(
  tx: HeliusTransaction,
  self: string
): string | null {
  for (const n of tx.nativeTransfers ?? []) {
    if (n.fromUserAccount === self) return n.toUserAccount;
    if (n.toUserAccount === self) return n.fromUserAccount;
  }
  for (const t of tx.tokenTransfers ?? []) {
    if (t.fromUserAccount === self) return t.toUserAccount;
    if (t.toUserAccount === self) return t.fromUserAccount;
  }
  return null;
}

function collectParticipants(tx: HeliusTransaction): string[] {
  const set = new Set<string>();
  for (const n of tx.nativeTransfers ?? []) {
    set.add(n.fromUserAccount);
    set.add(n.toUserAccount);
  }
  for (const t of tx.tokenTransfers ?? []) {
    set.add(t.fromUserAccount);
    set.add(t.toUserAccount);
  }
  return Array.from(set);
}

function defaultDex(source: string) {
  return (
    classifySolSource(source) ?? {
      id: source || "DEX",
      name: source || "DEX",
      category: "dex" as const,
    }
  );
}

function base(
  tx: HeliusTransaction,
  seq: number,
  type: OpType,
  protocol: ReturnType<typeof classifySolSource>,
  movement: TokenMovement[],
  status: "ok" | "failed",
  ctx: { selfAddress: string },
  gasUsd: number | null,
  notes?: string[],
  detection?: "explicit" | "auto"
): ClassifiedOp {
  const netUsd =
    movement
      .filter((m) => m.direction === "in")
      .reduce((s, m) => s + (m.usd ?? 0), 0) -
    movement
      .filter((m) => m.direction === "out")
      .reduce((s, m) => s + (m.usd ?? 0), 0);

  const counterparty = pickCounterpartyAddress(tx, ctx.selfAddress);

  const op: ClassifiedOp = {
    seq,
    hash: tx.signature,
    chain: "sol",
    time: tx.timestamp,
    status,
    type,
    protocol,
    movement,
    netUsd,
    gasUsd,
    counterparty,
    feePayer: tx.feePayer ?? null,
    fnName: tx.description ?? null,
    approveSpender: null,
    approveSymbol: null,
  };
  if (notes && notes.length) op.notes = notes;
  if (detection) op.detection = detection;
  return op;
}
