import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createDbClient } from "./client.js";

/**
 * Migrations are hand-written SQL files in `packages/db/drizzle/*.sql`, not
 * drizzle-kit-generated. We track applied files in `public.__migrations` (id,
 * filename, applied_at) and skip the ones already present. Each file runs
 * inside its own transaction; a failure halts the run and leaves the DB
 * unchanged for that file.
 */

const TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS public.__migrations (
    id            SERIAL PRIMARY KEY,
    filename      TEXT NOT NULL UNIQUE,
    applied_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

function migrationsDir(): string {
  // ESM-friendly resolution: dist/migrate.js → ../drizzle
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "drizzle");
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const client = createDbClient({ connectionString: databaseUrl });
  const pool = client.pool;

  try {
    console.log("[migrate] applying migrations…");

    await pool.query(TRACKING_TABLE);

    const dir = migrationsDir();
    const entries = await readdir(dir);
    const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();

    const { rows: appliedRows } = await pool.query<{ filename: string }>(
      "SELECT filename FROM public.__migrations",
    );
    const applied = new Set(appliedRows.map((r) => r.filename));

    let appliedCount = 0;
    for (const filename of sqlFiles) {
      if (applied.has(filename)) {
        console.log(`[migrate] skip ${filename} (already applied)`);
        continue;
      }
      const sql = await readFile(resolve(dir, filename), "utf8");
      const conn = await pool.connect();
      try {
        await conn.query("BEGIN");
        await conn.query(sql);
        await conn.query(
          "INSERT INTO public.__migrations (filename) VALUES ($1)",
          [filename],
        );
        await conn.query("COMMIT");
        console.log(`[migrate] applied ${filename}`);
        appliedCount++;
      } catch (err) {
        await conn.query("ROLLBACK");
        throw new Error(`[migrate] failed ${filename}: ${(err as Error).message}`);
      } finally {
        conn.release();
      }
    }

    console.log(`[migrate] done (${appliedCount} new, ${applied.size} prior).`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error("[migrate] failed:", error);
  process.exit(1);
});
