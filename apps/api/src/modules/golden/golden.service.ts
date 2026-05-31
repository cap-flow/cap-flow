/**
 * UCB Epic A3: service-layer for golden_cases + anomaly_flags (admin-only).
 *
 * No per-user ownership checks — these endpoints sit behind `requireAdmin`
 * (plan Q6). The admin curates golden anchors across any wallet (incl. the
 * dedicated test account). All mutations are audited, since a golden case is
 * a proven-correct oracle the detector and CI gate on.
 */
import { NotFoundError } from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";

import {
  type AnomalyFlagRow,
  type GoldenCaseInsert,
  type GoldenCasePatch,
  type GoldenCaseRow,
  GoldenRepository,
} from "./golden.repository.js";

export interface CreateGoldenInput {
  readonly walletId: string;
  readonly positionId: string;
  /** A3.6 stable global identity (see @cap-flow/ucb positionKey). */
  readonly positionKey: string | null;
  readonly chain: string;
  readonly protocolId: string;
  readonly marketKey: string | null;
  readonly openHash: string | null;
  readonly label: string;
  readonly kind: "golden" | "wrong";
  readonly issue: string | null;
  readonly expectedStartUsd: number | null;
  readonly expectedNetStartUsd: number | null;
  readonly expectedPnlUsd: number | null;
  readonly toleranceAbsUsd: number;
  readonly tolerancePct: number;
  readonly sourceOfTruth: string;
  readonly provenanceNote: string | null;
  readonly methodologyVersion: string;
  readonly fixturePath: string | null;
  /** A3.6 knowledge base: ops + cost-flow trace. */
  readonly derivation?: unknown;
}

function validateExpected(
  input: {
    expectedStartUsd: number | null;
    expectedNetStartUsd: number | null;
    expectedPnlUsd: number | null;
  },
  kind: "golden" | "wrong",
): void {
  // A GOLDEN anchor needs at least one expected value (it's an oracle). A
  // WRONG flag may have none — the user just knows it's incorrect/suspicious
  // (e.g. "current is 10× the start") without knowing the right number yet.
  if (
    kind === "golden" &&
    input.expectedStartUsd == null &&
    input.expectedNetStartUsd == null &&
    input.expectedPnlUsd == null
  ) {
    throw new NotFoundError(
      "Эталон требует хотя бы одно ожидаемое значение (startUsd / netStartUsd / pnlUsd).",
    );
  }
  // Only the three expected-* fields are numeric — do NOT iterate the whole
  // input (it carries string fields like walletId/label).
  for (const [k, v] of Object.entries(input)) {
    if (v != null && typeof v === "number" && !Number.isFinite(v)) {
      throw new NotFoundError(`${k} must be a finite number, got ${v}`);
    }
  }
}

export class GoldenService {
  constructor(
    private readonly repo: GoldenRepository,
    private readonly audit: AuditService,
  ) {}

  async createGolden(
    adminUserId: string,
    input: CreateGoldenInput,
  ): Promise<GoldenCaseRow> {
    validateExpected(input, input.kind);
    const insert: GoldenCaseInsert = {
      ...input,
      derivation: input.derivation ?? null,
      createdByUserId: adminUserId,
      promotedFromAnomalyId: null,
    };
    const row = await this.repo.createGolden(insert);
    await this.audit.log({
      actorUserId: adminUserId,
      action: "golden.case.create",
      target: row.id,
      payload: { label: input.label, walletId: input.walletId, positionId: input.positionId },
    });
    return row;
  }

  listGolden(walletId?: string): Promise<GoldenCaseRow[]> {
    return this.repo.listGolden(walletId ? { walletId } : {});
  }

  async patchGolden(
    adminUserId: string,
    id: string,
    patch: GoldenCasePatch,
  ): Promise<GoldenCaseRow> {
    if (
      "expectedStartUsd" in patch ||
      "expectedNetStartUsd" in patch ||
      "expectedPnlUsd" in patch
    ) {
      for (const v of [patch.expectedStartUsd, patch.expectedNetStartUsd, patch.expectedPnlUsd]) {
        if (v != null && !Number.isFinite(v)) {
          throw new NotFoundError(`expected value must be finite, got ${v}`);
        }
      }
    }
    const row = await this.repo.patchGolden(id, patch);
    if (!row) throw new NotFoundError(`Golden case ${id} not found.`);
    await this.audit.log({
      actorUserId: adminUserId,
      action: "golden.case.patch",
      target: id,
      payload: { status: patch.status ?? null },
    });
    return row;
  }

  /** Soft-retire (status='retired') — never hard-delete a proven anchor. */
  async retireGolden(adminUserId: string, id: string): Promise<GoldenCaseRow> {
    return this.patchGolden(adminUserId, id, { status: "retired" });
  }

  listAnomalies(filter: { status?: string; walletId?: string }): Promise<AnomalyFlagRow[]> {
    return this.repo.listAnomalies(filter);
  }

  async resolveAnomaly(
    adminUserId: string,
    id: string,
    status: "acknowledged" | "resolved",
    note: string | null,
  ): Promise<AnomalyFlagRow> {
    const row = await this.repo.patchAnomaly(id, {
      status,
      resolvedNote: note,
      resolvedAt: status === "resolved" ? new Date() : null,
    });
    if (!row) throw new NotFoundError(`Anomaly ${id} not found.`);
    await this.audit.log({
      actorUserId: adminUserId,
      action: `golden.anomaly.${status}`,
      target: id,
      payload: { hasNote: !!note },
    });
    return row;
  }

  /**
   * Promote an anomaly → golden case (learning loop). The anchor is taken from
   * the anomaly row; expected/provenance/label come from the request.
   */
  async promoteAnomaly(
    adminUserId: string,
    anomalyId: string,
    input: Omit<
      CreateGoldenInput,
      | "walletId"
      | "positionId"
      | "positionKey"
      | "chain"
      | "protocolId"
      | "marketKey"
      | "openHash"
      | "kind"
      | "issue"
    >,
  ): Promise<{ golden: GoldenCaseRow; anomaly: AnomalyFlagRow }> {
    // A promoted anomaly becomes a CORRECT anchor → always golden.
    validateExpected(input, "golden");
    const anomaly = await this.repo.getAnomaly(anomalyId);
    if (!anomaly) throw new NotFoundError(`Anomaly ${anomalyId} not found.`);
    if (!anomaly.walletId || !anomaly.positionId || !anomaly.protocolId) {
      throw new NotFoundError(
        `Anomaly ${anomalyId} is account-level (no position anchor) — cannot promote to a per-position golden case.`,
      );
    }
    const result = await this.repo.promoteAnomaly(anomalyId, {
      walletId: anomaly.walletId,
      positionId: anomaly.positionId,
      // Promoted anomalies lack supply symbols → no precise positionKey;
      // re-mark from the position UI to attach the stable key.
      positionKey: null,
      chain: anomaly.chain ?? "",
      protocolId: anomaly.protocolId,
      marketKey: anomaly.marketKey,
      openHash: null,
      label: input.label,
      kind: "golden",
      issue: null,
      expectedStartUsd: input.expectedStartUsd,
      expectedNetStartUsd: input.expectedNetStartUsd,
      expectedPnlUsd: input.expectedPnlUsd,
      toleranceAbsUsd: input.toleranceAbsUsd,
      tolerancePct: input.tolerancePct,
      sourceOfTruth: input.sourceOfTruth,
      provenanceNote: input.provenanceNote,
      methodologyVersion: input.methodologyVersion,
      fixturePath: input.fixturePath,
      derivation: null,
      createdByUserId: adminUserId,
      promotedFromAnomalyId: anomalyId,
    });
    await this.audit.log({
      actorUserId: adminUserId,
      action: "golden.anomaly.promote",
      target: anomalyId,
      payload: { goldenCaseId: result.golden.id, label: input.label },
    });
    return result;
  }
}
