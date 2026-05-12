import { createDbClient, type Database } from "@cap-flow/db";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}

export interface DbPluginOptions {
  readonly connectionString: string;
}

export const dbPlugin = fp<DbPluginOptions>(
  async (app: FastifyInstance, opts) => {
    const client = createDbClient({ connectionString: opts.connectionString });

    app.decorate("db", client.db);
    app.addHook("onClose", async () => {
      await client.close();
    });
  },
  { name: "db" }
);
