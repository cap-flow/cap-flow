/**
 * B5 — server-side loader: chain_operations.raw → UcbComputeWallet[] for the
 * canonical engine (ucb.service.computePositions).
 *
 * `chain_operations.raw` IS the frozen ClassifiedOp the client produced (the
 * DeBank/Helius classifier output, same shape the client feeds the engine), so
 * no normalize/zod is applied — that would break byte-parity (R4). We only
 * filter `status === "failed"` (R13) and order by op_time ASC (the lot tracker
 * consumes ops in time order; we do NOT inherit listByWallet's DESC default).
 *
 * The pure mapping (`rowsToComputeWallet`) is unit-tested; the thin drizzle
 * plumbing follows the existing repository style (untested, like
 * chain-ops.repository.ts).
 */
import { type Database, schema } from "@cap-flow/db";
import { and, asc, eq, ne } from "drizzle-orm";

import type { ClassifiedOp } from "@cap-flow/ucb/types";
import type { SavedWallet, WalletChain } from "@cap-flow/ucb/wallet";

import type { UcbComputeWallet } from "./ucb.service.js";

/** wallet_addresses.type → engine WalletChain (DeBank=evm, Helius=sol, rest=coinstats). */
export function toWalletChain(addressType: string): WalletChain {
  if (addressType === "evm") return "evm";
  if (addressType === "solana") return "sol";
  return "coinstats";
}

/**
 * PURE: build one `UcbComputeWallet` from a wallet row + its first address +
 * its chain_operation rows. Returns null when the wallet has no address (cannot
 * form a `SavedWallet`). Applies R13 (drop `status === "failed"`, defensively on
 * BOTH the column and `raw.status`) and preserves input order (caller queries
 * op_time ASC). `raw` passes through unchanged (frozen ClassifiedOp).
 */
export function rowsToComputeWallet(input: {
  wallet: { id: string; name: string; createdAt: Date };
  address: { address: string; type: string } | null;
  opRows: readonly { raw: unknown; status: string }[];
}): UcbComputeWallet | null {
  if (!input.address) return null;
  const wallet: SavedWallet = {
    id: input.wallet.id,
    name: input.wallet.name,
    address: input.address.address,
    chain: toWalletChain(input.address.type),
    createdAt: input.wallet.createdAt.getTime(),
  };
  const ops: ClassifiedOp[] = [];
  for (const row of input.opRows) {
    if (row.status === "failed") continue; // R13 (column)
    const op = row.raw as ClassifiedOp;
    if ((op as { status?: string }).status === "failed") continue; // R13 (raw, defensive)
    ops.push(op);
  }
  return { wallet, ops };
}

export class UcbOpsRepository {
  constructor(private readonly db: Database) {}

  /** Load every wallet of an account as engine input (ops from chain_operations). */
  async loadComputeWalletsForAccount(
    accountId: string,
  ): Promise<UcbComputeWallet[]> {
    const wallets = await this.db
      .select({
        id: schema.wallets.id,
        name: schema.wallets.name,
        createdAt: schema.wallets.createdAt,
      })
      .from(schema.wallets)
      .where(eq(schema.wallets.accountId, accountId));

    const out: UcbComputeWallet[] = [];
    for (const w of wallets) {
      const addrRows = await this.db
        .select({
          address: schema.walletAddresses.address,
          type: schema.walletAddresses.type,
        })
        .from(schema.walletAddresses)
        .where(eq(schema.walletAddresses.walletId, w.id))
        .orderBy(asc(schema.walletAddresses.id))
        .limit(1);

      const opRows = await this.db
        .select({
          raw: schema.chainOperations.raw,
          status: schema.chainOperations.status,
        })
        .from(schema.chainOperations)
        .where(
          and(
            eq(schema.chainOperations.walletId, w.id),
            ne(schema.chainOperations.status, "failed"),
          ),
        )
        .orderBy(asc(schema.chainOperations.opTime));

      const cw = rowsToComputeWallet({
        wallet: w,
        address: addrRows[0] ?? null,
        opRows,
      });
      if (cw) out.push(cw);
    }
    return out;
  }
}
