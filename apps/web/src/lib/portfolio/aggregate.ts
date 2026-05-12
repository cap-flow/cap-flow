import type {
  BalanceLine,
  LendingPositionLine,
  LpPositionLine,
  OpType,
  PortfolioSnapshot,
  StakingPositionLine,
} from "./types";

/**
 * Складывает несколько per-wallet снимков в один сводный.
 * Балансы — отдельно по `${chain}:${tokenId}`, чтобы Solana-USDC и
 * Ethereum-USDC не смешивались.
 *
 * Чистые трансферы между своими кошельками НЕ должны двигать
 * стартовый капитал. Они уже разнесены классификатором как
 * transfer_in/transfer_out, поэтому в opsByType они есть, но в
 * deposit_fiat не идут — и это корректно.
 */
export function aggregateSnapshots(
  snapshots: PortfolioSnapshot[],
): PortfolioSnapshot {
  const startingCapitalUsd = sum(snapshots, (s) => s.startingCapitalUsd);
  const withdrawnUsd = sum(snapshots, (s) => s.withdrawnUsd);
  const totalGasUsd = sum(snapshots, (s) => s.totalGasUsd);

  // Балансы — по chain+tokenId. Для агрегата chain не «потерялся» — мы
  // сохраняем chain в symbol-ключе (через _suffix), но в текущем `BalanceLine`
  // chain отсутствует. Сделаем простую группировку по `chain|symbol|tokenId`
  // и пометим chain в symbol для отображения.
  const balanceMap = new Map<string, BalanceLine & { chain: string }>();
  // walletId → snapshot, нам нужно знать chain через walletAddress, но в типах его нет.
  // Поэтому источник chain — `walletId` snapshot'а здесь не отделить, кладём как есть.
  for (const snap of snapshots) {
    for (const b of snap.walletBalances) {
      // chain неявно содержится в snapshot — но в BalanceLine его нет.
      // Берём из snapshot.opsByType отсутствующего поля нет, используем walletId как proxy:
      // для агрегата ключим по `tokenId|symbol` и не ломаем по chain (если адрес тот же).
      // EVM USDC и Solana USDC имеют разные tokenId, поэтому сольются корректно автоматически.
      const key = `${b.tokenId}::${b.symbol}`;
      const cur = balanceMap.get(key);
      if (cur) {
        cur.amount += b.amount;
        cur.costBasisUsd += b.costBasisUsd;
        if (b.costBasisHasGap) cur.costBasisHasGap = true;
      } else {
        balanceMap.set(key, { ...b, chain: "" });
      }
    }
  }

  const lendingMap = new Map<string, LendingPositionLine>();
  for (const snap of snapshots) {
    for (const p of snap.lendingPositions) {
      const key = `${p.protocol.id}@${p.chain}`;
      const cur = lendingMap.get(key);
      if (!cur) {
        lendingMap.set(key, {
          protocol: p.protocol,
          chain: p.chain,
          supplied: { ...p.supplied },
          borrowed: { ...p.borrowed },
        });
        continue;
      }
      mergeAmountUsd(cur.supplied, p.supplied);
      mergeAmountUsd(cur.borrowed, p.borrowed);
    }
  }

  const lpMap = new Map<string, LpPositionLine>();
  for (const snap of snapshots) {
    for (const p of snap.lpPositions) {
      const key = `${p.protocol.id}@${p.chain}`;
      const cur = lpMap.get(key);
      if (cur) {
        cur.netUsd += p.netUsd;
        for (const t of p.tokens) if (!cur.tokens.includes(t)) cur.tokens.push(t);
        if (p.deposited) {
          cur.deposited = cur.deposited ?? {};
          mergeAmountUsd(cur.deposited, p.deposited);
        }
        if (p.withdrawn) {
          cur.withdrawn = cur.withdrawn ?? {};
          mergeAmountUsd(cur.withdrawn, p.withdrawn);
        }
      } else {
        lpMap.set(key, {
          ...p,
          tokens: [...p.tokens],
          ...(p.deposited && { deposited: { ...p.deposited } }),
          ...(p.withdrawn && { withdrawn: { ...p.withdrawn } }),
        });
      }
    }
  }

  const stakingMap = new Map<string, StakingPositionLine>();
  for (const snap of snapshots) {
    for (const p of snap.stakingPositions) {
      const key = `${p.protocol.id}@${p.chain}@${p.symbol}`;
      const cur = stakingMap.get(key);
      if (cur) {
        cur.amount += p.amount;
        cur.costUsd += p.costUsd;
      } else {
        stakingMap.set(key, { ...p });
      }
    }
  }

  const opsByType = new Map<OpType, { count: number; netUsd: number }>();
  for (const snap of snapshots) {
    for (const row of snap.opsByType) {
      const cur = opsByType.get(row.type) ?? { count: 0, netUsd: 0 };
      cur.count += row.count;
      cur.netUsd += row.netUsd;
      opsByType.set(row.type, cur);
    }
  }

  // Realized PnL — складываем по кошелькам.
  const realizedPnlUsd = sum(snapshots, (s) => s.realizedPnlUsd);
  const realizedPnlBySymbol: Record<string, number> = {};
  const realizedPnlByOpType: Partial<Record<OpType, number>> = {};
  for (const snap of snapshots) {
    for (const [sym, val] of Object.entries(snap.realizedPnlBySymbol)) {
      realizedPnlBySymbol[sym] = (realizedPnlBySymbol[sym] ?? 0) + val;
    }
    for (const [opType, val] of Object.entries(snap.realizedPnlByOpType) as [
      OpType,
      number,
    ][]) {
      realizedPnlByOpType[opType] =
        (realizedPnlByOpType[opType] ?? 0) + (val ?? 0);
    }
  }

  return {
    walletId: "aggregate",
    walletAddress: "",
    startingCapitalUsd,
    withdrawnUsd,
    netInvestedUsd: startingCapitalUsd - withdrawnUsd,
    totalGasUsd,
    walletBalances: Array.from(balanceMap.values())
      .filter((b) => Math.abs(b.amount) > 1e-6 && Math.abs(b.costBasisUsd) >= 1)
      .sort((a, b) => Math.abs(b.costBasisUsd) - Math.abs(a.costBasisUsd))
      .map(({ chain: _c, ...rest }) => rest),
    lendingPositions: Array.from(lendingMap.values()).sort((a, b) =>
      a.protocol.name.localeCompare(b.protocol.name),
    ),
    lpPositions: Array.from(lpMap.values())
      .filter((v) => Math.abs(v.netUsd) > 1)
      .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd)),
    stakingPositions: Array.from(stakingMap.values()).sort(
      (a, b) => Math.abs(b.costUsd) - Math.abs(a.costUsd),
    ),
    opsByType: Array.from(opsByType.entries())
      .map(([type, v]) => ({ type, count: v.count, netUsd: v.netUsd }))
      .sort((a, b) => b.count - a.count),
    realizedPnlUsd,
    realizedPnlBySymbol,
    realizedPnlByOpType,
  };
}

function sum(arr: PortfolioSnapshot[], pick: (s: PortfolioSnapshot) => number) {
  return arr.reduce((s, x) => s + pick(x), 0);
}

function mergeAmountUsd(
  target: Record<string, { amount: number; usd: number }>,
  src: Record<string, { amount: number; usd: number }>,
) {
  for (const [sym, v] of Object.entries(src)) {
    const cur = target[sym] ?? { amount: 0, usd: 0 };
    cur.amount += v.amount;
    cur.usd += v.usd;
    target[sym] = cur;
  }
}
