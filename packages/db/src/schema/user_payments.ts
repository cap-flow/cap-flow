import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/** Existing enums covering the billing plans and payment kinds. */
export const paymentKindEnum = pgEnum("payment_kind", [
  "subscription",
  "refund",
  "trial",
  "one_time",
]);

export const paymentPlanEnum = pgEnum("payment_plan", [
  "trial",
  "monthly",
  "quarterly",
  "semiannual",
  "yearly",
  "lifetime",
  "custom",
]);

/**
 * User payments / subscriptions ledger.
 *
 * Inherited table — replaces my earlier `subscriptions` design. We append
 * crypto payment fields (TRC20/ERC20 receive address, payment method) in a
 * later migration when Phase 8 (billing) lands; for now the table is unused
 * but we surface the type so admin views can read it.
 */
export const userPayments = pgTable(
  "user_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: paymentKindEnum("kind").notNull(),
    plan: paymentPlanEnum("plan").notNull(),
    amountUsd: numeric("amount_usd", { precision: 28, scale: 8 })
      .notNull()
      .default("0"),
    horizonMonths: integer("horizon_months").notNull().default(0),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    refundedPaymentId: uuid("refunded_payment_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("user_payments_user_paid_idx").on(table.userId, table.paidAt),
  ]
);

export type UserPayment = typeof userPayments.$inferSelect;
export type NewUserPayment = typeof userPayments.$inferInsert;
