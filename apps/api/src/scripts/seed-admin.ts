/**
 * Seed-скрипт. Создаёт (или обновляет) пользователя-админа и его primary
 * аккаунт. Идемпотентен — можно прогонять много раз, существующие записи
 * не дублируются.
 *
 * Запуск (из корня репо):
 *   set -a && . ./.env && set +a && \
 *     pnpm --filter @cap-flow/api exec tsx src/scripts/seed-admin.ts
 */
import { createDbClient, schema } from "@cap-flow/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { hashPassword } from "../modules/auth/password.js";

const seedEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z
    .string()
    .min(12, "ADMIN_PASSWORD must be at least 12 characters"),
  ADMIN_NAME: z.string().min(1).default("Vladimir"),
  ADMIN_ACCOUNT_NAME: z.string().min(1).default("Main"),
});

async function main(): Promise<void> {
  const parsed = seedEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("[seed-admin] Invalid environment:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  const env = parsed.data;
  const email = env.ADMIN_EMAIL.toLowerCase();
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);

  const client = createDbClient({ connectionString: env.DATABASE_URL });

  try {
    const existing = await client.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    let userId: string;

    if (existing[0]) {
      userId = existing[0].id;
      console.log(
        `[seed-admin] user ${email} already exists (${userId}); refreshing role/password…`
      );
      await client.db
        .update(schema.users)
        .set({
          passwordHash,
          name: env.ADMIN_NAME,
          role: "admin",
          status: "active",
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, userId));
    } else {
      const [created] = await client.db
        .insert(schema.users)
        .values({
          email,
          name: env.ADMIN_NAME,
          passwordHash,
          role: "admin",
          status: "active",
        })
        .returning();
      if (!created) throw new Error("User insert returned no row.");
      userId = created.id;
      console.log(`[seed-admin] created admin ${email} (${userId})`);
    }

    // Ensure a primary account exists.
    const primary = await client.db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.ownerId, userId),
          eq(schema.accounts.isPrimary, true)
        )
      )
      .limit(1);

    if (!primary[0]) {
      const [account] = await client.db
        .insert(schema.accounts)
        .values({
          ownerId: userId,
          name: env.ADMIN_ACCOUNT_NAME,
          isPrimary: true,
        })
        .returning();
      console.log(
        `[seed-admin] created primary account "${env.ADMIN_ACCOUNT_NAME}" (${account?.id})`
      );
    } else {
      console.log(
        `[seed-admin] primary account already exists (${primary[0].id})`
      );
    }

    console.log("[seed-admin] done.");
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error("[seed-admin] failed:", err);
  process.exit(1);
});
