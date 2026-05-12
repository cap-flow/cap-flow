import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env["DATABASE_URL"];

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Provide it via .env or shell before running drizzle-kit."
  );
}

export default defineConfig({
  // We point at the *compiled* schema in dist/. drizzle-kit's TS loader
  // doesn't resolve ESM `.js` extensions used by NodeNext, but compiled JS
  // works fine. Run `pnpm --filter @cap-flow/db build` before generate.
  schema: "./dist/schema/index.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
