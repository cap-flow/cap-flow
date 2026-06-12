/**
 * B6 — typed client for the server-canonical positions endpoint (slice 1).
 * `positions` is an opaque `OpenPosition[]` (validated structurally elsewhere);
 * we keep it `unknown[]` here, mirroring the shadow-diff internal surface.
 */
import { z } from "zod";

import { api } from "@/lib/api/client";

export const servePositionsSchema = z.object({
  serve: z.boolean(),
  reason: z.string(),
  positions: z.array(z.unknown()).nullable(),
  computedAt: z.string().nullable(),
  engineVersion: z.string().nullable(),
  lotMethodology: z.string().nullable(),
});

export type ServePositionsDto = z.infer<typeof servePositionsSchema>;

const recomputeSchema = z.object({
  positionCount: z.number().nullable(),
  error: z.string().nullable(),
});

export const ucbApi = {
  getServerPositions: (accountId: string, signal?: AbortSignal) =>
    api.get(
      `/v1/accounts/${accountId}/ucb/positions`,
      servePositionsSchema,
      signal,
    ),
  /** Server-only UX: пересчитать аккаунт на сервере (после смены методики). */
  recomputeServerPositions: (accountId: string) =>
    api.post(`/v1/accounts/${accountId}/ucb/recompute`, {}, recomputeSchema),
};
