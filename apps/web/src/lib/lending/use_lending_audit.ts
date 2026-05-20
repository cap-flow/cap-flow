/**
 * Универсальный on-chain audit для **всех** lending позиций.
 *
 * Расширение `useAaveLendingAudit` на любые lending protocols через registry
 * receipt-token адресов (`receipt_registry.ts`). Срабатывает для каждой
 * позиции с `lp.category === "lending"`, **независимо от протокола**.
 *
 * Алгоритм:
 *   1. Для каждой lending позиции в `loaded` собираем (chain, walletAddr,
 *      protocolId, protocolName, underlyingTokenId, symbol).
 *   2. Резолвим receipt token address через `resolveReceiptAddress`:
 *      - Aave V3 / Spark / Compound V3 → static registry (instant)
 *      - Другие протоколы → null → skip (graceful)
 *   3. Через Etherscan v2 tokentx фетчим все Transfer events этого receipt'а
 *      для walletAddress, считаем Σ mints − Σ burns = on-chain netDeposited.
 *   4. Возвращаем Map<key, { netDeposited, mintTxHashes, … }> которая
 *      попадает в `buildOpenPositions` через `lendingAuditByKey`.
 *
 * Если protocol не поддерживается → quiet skip, ops-derived sum используется
 * как было. Расширение coverage — добавлением entries в `STATIC_RECEIPT_REGISTRY`.
 */

import { useEffect, useMemo, useState } from "react";

import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import {
  EtherscanChainNotSupportedError,
  fetchEtherscanTokenTransfers,
} from "../etherscan_logs";
import { resolveReceiptAddress } from "./receipt_registry";

export interface LendingAuditEntry {
  /** Σ all mint events of receipt token (Transfer from=0x0). */
  totalMinted: number;
  /** Σ all burn events of receipt token (Transfer to=0x0). */
  totalBurned: number;
  /** Net = minted - burned. Authoritative on-chain deposit total. */
  netDeposited: number;
  /** All mint tx hashes для UI / diagnostics. */
  mintTxHashes: readonly string[];
  /** Earliest mint timestamp (openedAt fallback). */
  earliestMintTime: number | null;
  /** Normalized protocolId, для логов. */
  protocolId: string;
}

/**
 * Ключ: `${chain}|${walletAddress.toLowerCase()}|${underlyingTokenId.toLowerCase()}`
 *
 * Не включаем protocolId — у одного юзера на одном chain'е один и тот же
 * underlying в одном lending protocol'е. Если в будущем появятся multi-market
 * протоколы (e.g. Morpho Blue) — расширим key.
 */
export type LendingAuditMap = Map<string, LendingAuditEntry>;

export function lendingAuditKey(args: {
  chain: string;
  walletAddress: string;
  underlyingTokenId: string;
}): string {
  return `${args.chain}|${args.walletAddress.toLowerCase()}|${args.underlyingTokenId.toLowerCase()}`;
}

interface State {
  data: LendingAuditMap;
  loading: boolean;
}

const EMPTY: LendingAuditMap = new Map();

interface AuditRequest {
  chain: string;
  walletAddress: string;
  underlyingTokenId: string;
  receiptAddress: string;
  symbol: string;
  protocolId: string;
}

export function useLendingAudit(
  loaded: Loaded[],
  alchemyKey: string,
  etherscanKey: string,
): State {
  void alchemyKey; // currently не нужен (используем только Etherscan + static registry)

  const requests = useMemo<AuditRequest[]>(() => {
    if (!etherscanKey) return [];
    const out: AuditRequest[] = [];
    const seen = new Set<string>();
    for (const l of loaded) {
      if (l.wallet.chain !== "evm") continue;
      if (!l.live) continue;
      for (const lp of l.live.positions) {
        // Только lending — единственная категория с supply yield rebase.
        if (lp.category !== "lending") continue;
        for (const s of lp.supply) {
          if (!s.tokenId) continue;
          // Skip accounting / debt receipt'ы.
          if (/^a[A-Z]/.test(s.symbol)) continue;
          if (/^variableDebt|^stableDebt/i.test(s.symbol)) continue;
          const addr = s.tokenId.includes(":")
            ? s.tokenId.split(":").pop()!
            : s.tokenId;
          if (!addr.startsWith("0x")) continue;
          // Резолвим receipt token через registry — этот шаг и определяет
          // поддерживается ли протокол.
          const receipt = resolveReceiptAddress(
            lp.protocolId,
            lp.protocolName,
            lp.chain,
            addr,
          );
          if (!receipt) continue; // graceful skip — unsupported protocol/asset
          const key = `${lp.chain}|${l.wallet.address.toLowerCase()}|${addr.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            chain: lp.chain,
            walletAddress: l.wallet.address,
            underlyingTokenId: addr,
            receiptAddress: receipt,
            symbol: s.symbol,
            protocolId: lp.protocolId,
          });
        }
      }
    }
    return out;
  }, [loaded, etherscanKey]);

  const [data, setData] = useState<LendingAuditMap>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      console.log(
        `[lending audit] effect run: ${requests.length} requests, etherscanKey=${etherscanKey ? "✓" : "✗"}`,
      );
    }
    if (requests.length === 0) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    setLoading(true);

    (async () => {
      const result: LendingAuditMap = new Map();
      await Promise.allSettled(
        requests.map(async (req) => {
          if (cancelled) return;
          let transfers;
          try {
            transfers = await fetchEtherscanTokenTransfers(
              req.chain,
              req.receiptAddress,
              req.walletAddress,
              etherscanKey,
            );
          } catch (e) {
            if (e instanceof EtherscanChainNotSupportedError) return;
            console.warn(
              `[lending audit] fetch failed ${req.chain}|${req.symbol}:`,
              (e as Error).message,
            );
            return;
          }
          if (cancelled) return;
          const ZERO = "0x0000000000000000000000000000000000000000";
          const user = req.walletAddress.toLowerCase();
          let totalMintedRaw = 0n;
          let totalBurnedRaw = 0n;
          const mintTxHashes: string[] = [];
          let earliestMint = Number.POSITIVE_INFINITY;
          let decimals = 18;
          for (const t of transfers) {
            decimals = t.tokenDecimal;
            const valBig = BigInt(t.value);
            if (t.from === ZERO && t.to === user) {
              totalMintedRaw += valBig;
              mintTxHashes.push(t.hash);
              if (t.timeStamp < earliestMint) earliestMint = t.timeStamp;
            } else if (t.from === user && t.to === ZERO) {
              totalBurnedRaw += valBig;
            }
          }
          const div = 10 ** decimals;
          const entry: LendingAuditEntry = {
            totalMinted: Number(totalMintedRaw) / div,
            totalBurned: Number(totalBurnedRaw) / div,
            netDeposited: Number(totalMintedRaw - totalBurnedRaw) / div,
            mintTxHashes,
            earliestMintTime: Number.isFinite(earliestMint)
              ? earliestMint
              : null,
            protocolId: req.protocolId,
          };
          const key = lendingAuditKey({
            chain: req.chain,
            walletAddress: req.walletAddress,
            underlyingTokenId: req.underlyingTokenId,
          });
          result.set(key, entry);
          if (typeof window !== "undefined") {
            console.log(
              `[lending audit] ${req.chain}/${req.symbol} (${req.protocolId}) ` +
                `netDeposited=${entry.netDeposited.toFixed(6)} ` +
                `(mints=${entry.totalMinted.toFixed(6)}, burns=${entry.totalBurned.toFixed(6)})`,
            );
          }
        }),
      );
      if (!cancelled) {
        if (typeof window !== "undefined") {
          console.log(
            `[lending audit] done: ${result.size}/${requests.length} entries resolved`,
          );
        }
        setData(result);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requests, etherscanKey]);

  return { data, loading };
}
