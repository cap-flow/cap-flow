/**
 * Per-user UCB lot methodology persistence (FIFO/LIFO/WAC/HIFO). Stored on
 * `users.lot_methodology` (NULL = FIFO default) so the server shadow compute
 * follows the user's UI choice. The single source the worker's methodology
 * resolver + the /me/lot-methodology API both read.
 */
import { type Database, schema } from "@cap-flow/db";
import { eq } from "drizzle-orm";

import type { LotMethodology } from "@cap-flow/ucb/lots/types";

const VALID: ReadonlySet<string> = new Set(["FIFO", "LIFO", "WAC", "HIFO"]);

export function coerceMethodology(v: string | null | undefined): LotMethodology {
  return v && VALID.has(v) ? (v as LotMethodology) : "FIFO";
}

export class LotMethodologyRepository {
  constructor(private readonly db: Database) {}

  /** The user's stored methodology, or null if unset (→ FIFO default). */
  async get(userId: string): Promise<LotMethodology | null> {
    const rows = await this.db
      .select({ m: schema.users.lotMethodology })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const raw = rows[0]?.m ?? null;
    return raw && VALID.has(raw) ? (raw as LotMethodology) : null;
  }

  async set(userId: string, methodology: LotMethodology): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ lotMethodology: methodology, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  }
}
