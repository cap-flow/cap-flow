import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";

import type {
  BillingRepository,
  CryptoNetwork,
  PaymentAddressRow,
  UserPaymentRow,
} from "./billing.repository.js";
import {
  plansFromConfig,
  selectPlanForAmount,
  type PricingConfig,
} from "./pricing.js";

export interface BillingConfig extends PricingConfig {
  readonly graceDays: number;
  readonly addressPoolTrc20: string[];
  readonly addressPoolErc20: string[];
}

export type SubscriptionStatus =
  | "beta"
  | "active"
  | "grace"
  | "expired";

export interface SubscriptionInfo {
  readonly status: SubscriptionStatus;
  /** Last billed payment row, if any. */
  readonly latestPayment: UserPaymentRow | null;
  readonly periodEnd: Date | null;
  readonly graceUntil: Date | null;
  readonly daysLeft: number | null;
}

export class BillingService {
  constructor(
    private readonly repo: BillingRepository,
    private readonly audit: AuditService,
    private readonly cfg: BillingConfig
  ) {}

  // ─── status ───────────────────────────────────────────────────────

  async getSubscription(userId: string): Promise<SubscriptionInfo> {
    const latest = await this.repo.latestActiveSubscription(userId);
    if (!latest || !latest.periodEnd) {
      return {
        status: "beta",
        latestPayment: latest,
        periodEnd: null,
        graceUntil: null,
        daysLeft: null,
      };
    }
    const now = Date.now();
    const periodEndMs = latest.periodEnd.getTime();
    const graceUntilMs = periodEndMs + this.cfg.graceDays * 86_400_000;
    let status: SubscriptionStatus;
    if (now < periodEndMs) status = "active";
    else if (now < graceUntilMs) status = "grace";
    else status = "expired";

    const daysLeft = Math.max(
      0,
      Math.ceil(
        (status === "expired" ? 0 : (status === "grace" ? graceUntilMs : periodEndMs) - now) /
          86_400_000
      )
    );
    return {
      status,
      latestPayment: latest,
      periodEnd: latest.periodEnd,
      graceUntil: new Date(graceUntilMs),
      daysLeft,
    };
  }

  // ─── address allocation ───────────────────────────────────────────

  /**
   * Return the receive address for (user, network). Allocates from the
   * pool on first call. Static pool today; HD-wallet rotation in Phase 8b
   * — the contract here is "same user always gets the same address per
   * network" so the monitor's address-to-user mapping is stable.
   */
  async getOrAllocateAddress(
    userId: string,
    network: CryptoNetwork
  ): Promise<PaymentAddressRow> {
    const existing = await this.repo.findUserAddress(userId, network);
    if (existing) return existing;

    const pool =
      network === "trc20"
        ? this.cfg.addressPoolTrc20
        : this.cfg.addressPoolErc20;
    if (pool.length === 0) {
      throw new ConflictError(
        `${network.toUpperCase()} address pool is empty. Admin must seed BILLING_ADDRESS_POOL_${network.toUpperCase()}.`
      );
    }

    // Find the first pool entry that's not yet assigned to another user.
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i]!;
      const used = await this.repo.findByAddress(network, candidate);
      if (!used) {
        const row = await this.repo.insertAddress({
          userId,
          network,
          address: candidate,
          derivationIndex: i,
        });
        await this.audit.log({
          actorUserId: userId,
          action: "billing.address_allocated",
          payload: { network, address: candidate, poolIndex: i },
        });
        return row;
      }
    }
    throw new ConflictError(
      `All ${network.toUpperCase()} pool addresses are taken; admin must add more.`
    );
  }

  // ─── manual admin operations ──────────────────────────────────────

  async creditManual(
    args: {
      userId: string;
      amountUsd: number;
      note?: string;
      actorAdminId: string;
    }
  ): Promise<UserPaymentRow> {
    const plan = selectPlanForAmount(args.amountUsd, plansFromConfig(this.cfg));
    if (!plan) {
      throw new ForbiddenError(
        `Amount $${args.amountUsd} is below the smallest plan price.`
      );
    }
    const current = await this.repo.latestActiveSubscription(args.userId);
    const now = Date.now();
    const from =
      current?.periodEnd && current.periodEnd.getTime() > now
        ? current.periodEnd.getTime()
        : now;
    const periodEnd = new Date(from + plan.months * 30 * 86_400_000);

    const row = await this.repo.creditPayment({
      userId: args.userId,
      amountUsd: args.amountUsd.toFixed(2),
      horizonMonths: plan.months,
      plan: plan.key,
      paymentMethod: "manual",
      note: args.note ?? null,
      periodEnd,
    });

    await this.audit.log({
      actorUserId: args.actorAdminId,
      asAdmin: true,
      targetUserId: args.userId,
      action: "billing.credited_manual",
      payload: {
        paymentId: row.id,
        amount: args.amountUsd,
        plan: plan.key,
        periodEnd: periodEnd.toISOString(),
      },
    });
    return row;
  }

  async refund(args: {
    paymentId: string;
    actorAdminId: string;
    note?: string;
  }): Promise<UserPaymentRow> {
    // Caller fetches history → picks paymentId. We resolve user via the row
    // implicitly through the FK; here we just look it up via history scan.
    // Cheap because admin actions are rare.
    const allByPayment = await this.repo.paymentHistory(args.paymentId).catch(() => []);
    // The above is paymentHistory(userId), so this guard never matches — we
    // use a dedicated query in the route layer instead.
    void allByPayment;
    throw new NotFoundError(
      "Refund must be initiated from /admin/users/:id/billing/refund where we resolve userId from path."
    );
  }

  async refundForUser(args: {
    userId: string;
    paymentId: string;
    actorAdminId: string;
    note?: string;
  }): Promise<UserPaymentRow> {
    const history = await this.repo.paymentHistory(args.userId);
    const target = history.find((p) => p.id === args.paymentId);
    if (!target) {
      throw new NotFoundError(
        `Payment '${args.paymentId}' not found for user '${args.userId}'.`
      );
    }
    if (target.kind !== "subscription") {
      throw new ConflictError(
        `Cannot refund payment of kind '${target.kind}'.`
      );
    }
    const row = await this.repo.insertRefund(
      args.userId,
      args.paymentId,
      `-${target.amountUsd}`,
      args.note ?? null
    );
    await this.audit.log({
      actorUserId: args.actorAdminId,
      asAdmin: true,
      targetUserId: args.userId,
      action: "billing.refunded",
      payload: { refundOf: args.paymentId, amount: target.amountUsd },
    });
    return row;
  }

  async getHistory(userId: string): Promise<UserPaymentRow[]> {
    return this.repo.paymentHistory(userId);
  }
}
