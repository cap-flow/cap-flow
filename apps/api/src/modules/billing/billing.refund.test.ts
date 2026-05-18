import { beforeEach, describe, expect, it } from "vitest";

import { BillingService, type BillingConfig } from "./billing.service.js";
import type {
  BillingRepository,
  CreditPaymentInput,
  UserPaymentRow,
} from "./billing.repository.js";
import type { AuditService } from "../audit/audit.service.js";

/**
 * Refund behavior contract (B1):
 *
 *   - `latestActiveSubscription(userId)` MUST exclude any subscription
 *     that has a corresponding `kind=refund` row pointing at it via
 *     `refundedPaymentId`.
 *   - `getSubscription(userId).status` MUST reflect the refund:
 *     - Refunded latest subscription → fall through to the most recent
 *       still-valid one (or "beta" if none).
 *
 * Pre-fix bug: refund only inserted a ledger row, never invalidated the
 * original. Users kept full access until original `periodEnd`.
 */

const CFG: BillingConfig = {
  price3m: 100,
  price6m: 180,
  price12m: 300,
  graceDays: 3,
  addressPoolTrc20: [],
  addressPoolErc20: [],
};

class FakeRepo {
  payments: UserPaymentRow[] = [];

  async latestActiveSubscription(userId: string): Promise<UserPaymentRow | null> {
    // Replicate the (post-fix) production query: kind=subscription,
    // period_end NOT NULL, ORDER BY period_end DESC, exclude any
    // subscription that has a refund row pointing at it.
    const refundedIds = new Set(
      this.payments
        .filter((p) => p.kind === "refund" && p.refundedPaymentId)
        .map((p) => p.refundedPaymentId!)
    );
    const subs = this.payments
      .filter(
        (p) =>
          p.userId === userId &&
          p.kind === "subscription" &&
          p.periodEnd != null &&
          !refundedIds.has(p.id)
      )
      .sort((a, b) => b.periodEnd!.getTime() - a.periodEnd!.getTime());
    return subs[0] ?? null;
  }

  async paymentHistory(userId: string): Promise<UserPaymentRow[]> {
    return this.payments
      .filter((p) => p.userId === userId)
      .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime());
  }

  async creditPayment(input: CreditPaymentInput): Promise<UserPaymentRow> {
    const row: UserPaymentRow = {
      id: `pay-${this.payments.length + 1}`,
      userId: input.userId,
      kind: "subscription",
      plan: input.plan,
      amountUsd: input.amountUsd,
      horizonMonths: input.horizonMonths,
      paidAt: new Date(),
      periodEnd: input.periodEnd,
      refundedPaymentId: null,
      note: input.note ?? null,
      createdAt: new Date(),
    };
    this.payments.push(row);
    return row;
  }

  async insertRefund(
    userId: string,
    refundedPaymentId: string,
    amountUsd: string,
    note: string | null
  ): Promise<UserPaymentRow> {
    const row: UserPaymentRow = {
      id: `refund-${this.payments.length + 1}`,
      userId,
      kind: "refund",
      plan: "custom",
      amountUsd,
      horizonMonths: 0,
      paidAt: new Date(),
      periodEnd: null,
      refundedPaymentId,
      note,
      createdAt: new Date(),
    };
    this.payments.push(row);
    return row;
  }
}

const noopAudit: AuditService = {
  log: async () => undefined,
} as unknown as AuditService;

function makeService(repo: FakeRepo): BillingService {
  return new BillingService(
    repo as unknown as BillingRepository,
    noopAudit,
    CFG
  );
}

describe("BillingService — refund invalidates subscription", () => {
  let repo: FakeRepo;
  let svc: BillingService;

  beforeEach(() => {
    repo = new FakeRepo();
    svc = makeService(repo);
  });

  it("active subscription before any refund", async () => {
    await repo.creditPayment({
      userId: "u1",
      amountUsd: "300.00",
      horizonMonths: 12,
      plan: "yearly",
      paymentMethod: "manual",
      periodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    const sub = await svc.getSubscription("u1");
    expect(sub.status).toBe("active");
  });

  it("status drops to 'beta' after the only subscription is refunded", async () => {
    const created = await repo.creditPayment({
      userId: "u2",
      amountUsd: "300.00",
      horizonMonths: 12,
      plan: "yearly",
      paymentMethod: "manual",
      periodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    await repo.insertRefund("u2", created.id, "-300.00", "test refund");

    const sub = await svc.getSubscription("u2");
    expect(sub.status).toBe("beta");
    expect(sub.latestPayment).toBeNull();
    expect(sub.periodEnd).toBeNull();
  });

  it("falls through to earlier active subscription when latest is refunded", async () => {
    const early = await repo.creditPayment({
      userId: "u3",
      amountUsd: "100.00",
      horizonMonths: 3,
      plan: "quarterly",
      paymentMethod: "manual",
      periodEnd: new Date(Date.now() + 7 * 86_400_000),
    });
    const latest = await repo.creditPayment({
      userId: "u3",
      amountUsd: "300.00",
      horizonMonths: 12,
      plan: "yearly",
      paymentMethod: "manual",
      periodEnd: new Date(Date.now() + 90 * 86_400_000),
    });
    await repo.insertRefund("u3", latest.id, "-300.00", null);

    const sub = await svc.getSubscription("u3");
    expect(sub.status).toBe("active");
    expect(sub.latestPayment?.id).toBe(early.id);
  });

  it("refund of an earlier sub does NOT affect a later one", async () => {
    const early = await repo.creditPayment({
      userId: "u4",
      amountUsd: "100.00",
      horizonMonths: 3,
      plan: "quarterly",
      paymentMethod: "manual",
      periodEnd: new Date(Date.now() + 7 * 86_400_000),
    });
    const latest = await repo.creditPayment({
      userId: "u4",
      amountUsd: "300.00",
      horizonMonths: 12,
      plan: "yearly",
      paymentMethod: "manual",
      periodEnd: new Date(Date.now() + 90 * 86_400_000),
    });
    await repo.insertRefund("u4", early.id, "-100.00", null);

    const sub = await svc.getSubscription("u4");
    expect(sub.status).toBe("active");
    expect(sub.latestPayment?.id).toBe(latest.id);
  });
});
