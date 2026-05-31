/**
 * Annotation input contract for the UCB engine (A0).
 *
 * The web client derives this same shape via `z.infer<resolvedAnnotationSchema>`
 * in `apps/web/src/features/chain-ops/api.ts`. Defined here as a plain
 * interface so the engine (apply_annotations / ucb_pipeline) has no dependency
 * on the web API layer; web's zod-inferred type is structurally identical and
 * therefore assignable to this.
 */
export interface ResolvedAnnotation {
  id: string;
  chainOpId: string;
  userId: string;
  isInternalTransfer: boolean | null;
  manualCostBasisUsd: number | null;
  manualOpType: string | null;
  note: string | null;
  /**
   * UCB D8. zod `.optional().default(false)`. Declared as explicit
   * `boolean | undefined` (not bare optional) so the emitted .d.ts stays
   * assignable from web's inferred type when web compiles under
   * `exactOptionalPropertyTypes: true`. The engine reads `a.excluded === true`.
   */
  excluded?: boolean | undefined;
  createdAt: string;
  updatedAt: string;
  // resolvedAnnotationSchema extensions:
  txHash: string;
  walletId: string;
  logIndex: number;
}
