import { type Database, schema } from "@cap-flow/db";
import { asc, eq } from "drizzle-orm";

export type ChatTemplateRow = typeof schema.chatTemplates.$inferSelect;

export interface CreateTemplateInput {
  readonly title: string;
  readonly body: string;
  readonly sortOrder?: number;
  readonly createdBy: string | null;
}

export interface UpdateTemplateInput {
  readonly title?: string;
  readonly body?: string;
  readonly sortOrder?: number;
}

export class ChatTemplatesRepository {
  constructor(private readonly db: Database) {}

  list(): Promise<ChatTemplateRow[]> {
    return this.db
      .select()
      .from(schema.chatTemplates)
      .orderBy(asc(schema.chatTemplates.sortOrder), asc(schema.chatTemplates.createdAt));
  }

  async create(input: CreateTemplateInput): Promise<ChatTemplateRow> {
    const [row] = await this.db
      .insert(schema.chatTemplates)
      .values({
        title: input.title,
        body: input.body,
        sortOrder: input.sortOrder ?? 0,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error("chat_templates insert returned no row.");
    return row;
  }

  async update(id: string, input: UpdateTemplateInput): Promise<ChatTemplateRow | null> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) patch["title"] = input.title;
    if (input.body !== undefined) patch["body"] = input.body;
    if (input.sortOrder !== undefined) patch["sortOrder"] = input.sortOrder;
    const [row] = await this.db
      .update(schema.chatTemplates)
      .set(patch)
      .where(eq(schema.chatTemplates.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.chatTemplates)
      .where(eq(schema.chatTemplates.id, id))
      .returning({ id: schema.chatTemplates.id });
    return rows.length > 0;
  }
}
