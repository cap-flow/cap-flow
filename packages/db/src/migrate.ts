import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDbClient } from "./client.js";

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const client = createDbClient({ connectionString: databaseUrl });

  try {
    console.log("[migrate] applying migrations…");
    await migrate(client.db, { migrationsFolder: "./drizzle" });
    console.log("[migrate] done.");
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error("[migrate] failed:", error);
  process.exit(1);
});
