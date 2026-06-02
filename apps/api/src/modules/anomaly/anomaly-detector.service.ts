/**
 * Epic C detector — per-account scan. Loads the SERVER's canonical positions
 * (latest ucb_shadow_results) + the account's golden_cases, runs the post-port
 * checks (golden_case_drift + canonical invariants), and persists findings to
 * anomaly_flags (upsert + auto-resolve no-longer-tripping). Account-scoped.
 *
 * Reads already-persisted shadow results → adds no latency to refresh; meant to
 * run on a schedule (BullMQ, follow-up) or on demand (admin scan route).
 */
import { findingKey, type AnomalyFlagsRepository } from "./anomaly-flags.repository.js";
import { runPostPortChecks, type CanonicalPosition, type GoldenCaseView } from "./post_port_checks.js";

/** Latest canonical positions for an account (subset of the shadow row). */
export interface ShadowResultSource {
  findLatestForAccount(
    accountId: string,
  ): Promise<{ positions: unknown[] } | null>;
}

/** Golden cases for a wallet (golden.repository shape). */
export interface GoldenCaseSource {
  listGolden(filter: { walletId?: string }): Promise<RawGoldenCase[]>;
}

/** Raw golden_cases row (numerics as strings). */
export interface RawGoldenCase {
  id: string;
  walletId: string;
  chain: string;
  protocolId: string;
  marketKey: string | null;
  openHash: string | null;
  label: string;
  kind: string;
  status: string;
  expectedStartUsd: string | null;
  toleranceAbsUsd: string;
  tolerancePct: string;
}

export interface AnomalyDetectorDeps {
  shadowRepo: ShadowResultSource;
  goldenRepo: GoldenCaseSource;
  flagsRepo: Pick<AnomalyFlagsRepository, "upsertMany" | "autoResolveStale">;
  /** Wallet ids of an account (to scope golden_cases). */
  walletIdsForAccount(accountId: string): Promise<string[]>;
  detectorVersion: string;
}

export interface ScanResult {
  skipped?: boolean;
  positions?: number;
  goldenCases?: number;
  findings?: number;
  resolved?: number;
  bySeverity?: Record<string, number>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function adaptPositions(raw: unknown[]): CanonicalPosition[] {
  return raw.map((r: any) => ({
    id: String(r.id ?? ""),
    walletId: String(r.walletId ?? ""),
    chain: String(r.chain ?? ""),
    protocol: { id: String(r.protocol?.id ?? r.protocol?.name ?? "") },
    lpTokenId: r.lpTokenId ?? null,
    matchedV3TokenId: r.matchedV3TokenId ?? null,
    openHash: r.openHash ?? null,
    startUsd: Number(r.startUsd ?? 0),
    currentUsd: Number(r.currentUsd ?? 0),
    netPnlUsd: Number(r.netPnlUsd ?? 0),
    coverageIncomplete: Boolean(r.coverageIncomplete),
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function adaptGolden(rows: RawGoldenCase[]): GoldenCaseView[] {
  return rows.map((g) => ({
    id: g.id,
    walletId: g.walletId,
    chain: g.chain,
    protocolId: g.protocolId,
    marketKey: g.marketKey,
    openHash: g.openHash,
    label: g.label,
    kind: g.kind,
    status: g.status,
    expectedStartUsd: g.expectedStartUsd == null ? null : Number(g.expectedStartUsd),
    toleranceAbsUsd: Number(g.toleranceAbsUsd),
    tolerancePct: Number(g.tolerancePct),
  }));
}

export class AnomalyDetectorService {
  constructor(private readonly deps: AnomalyDetectorDeps) {}

  async scanAccount(accountId: string): Promise<ScanResult> {
    const latest = await this.deps.shadowRepo.findLatestForAccount(accountId);
    if (!latest) return { skipped: true };

    const positions = adaptPositions(latest.positions);

    const walletIds = await this.deps.walletIdsForAccount(accountId);
    const goldenRows: RawGoldenCase[] = [];
    for (const walletId of walletIds) {
      goldenRows.push(...(await this.deps.goldenRepo.listGolden({ walletId })));
    }
    const golden = adaptGolden(goldenRows);

    const findings = runPostPortChecks(positions, golden);

    await this.deps.flagsRepo.upsertMany(accountId, findings, this.deps.detectorVersion);
    const trippingKeys = new Set(findings.map((f) => findingKey(f)));
    const resolved = await this.deps.flagsRepo.autoResolveStale(accountId, trippingKeys);

    const bySeverity: Record<string, number> = {};
    for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

    return {
      positions: positions.length,
      goldenCases: golden.length,
      findings: findings.length,
      resolved,
      bySeverity,
    };
  }
}
