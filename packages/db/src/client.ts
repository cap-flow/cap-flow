import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

export interface CreateDbClientOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly ssl?: pg.PoolConfig["ssl"];
}

export interface DbClient {
  readonly db: Database;
  readonly pool: pg.Pool;
  readonly close: () => Promise<void>;
}

/**
 * Creates a Drizzle client wrapped around a pg.Pool.
 * The pool is the long-lived resource — call `close()` on graceful shutdown.
 */
export function createDbClient(options: CreateDbClientOptions): DbClient {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
