/**
 * Subscription pricing table — the canonical source of (plan → price, months).
 *
 * Plan keys match the existing `payment_plan` enum in the DB
 * (`quarterly/semiannual/yearly/custom`). Our Capflow offering is 3/6/12
 * months — those naturally map onto quarterly/semiannual/yearly.
 */
export type SubscriptionPlanKey = "quarterly" | "semiannual" | "yearly";

export interface PlanDef {
  readonly key: SubscriptionPlanKey;
  readonly priceUsd: number;
  readonly months: number;
  /** Stretch factor for credit decisions: if the incoming amount is at
   *  least `priceUsd * tolerance`, the payment is credited as that plan. */
  readonly tolerance: number;
}

export interface PricingConfig {
  readonly price3m: number;
  readonly price6m: number;
  readonly price12m: number;
}

export function plansFromConfig(cfg: PricingConfig): PlanDef[] {
  return [
    { key: "quarterly", priceUsd: cfg.price3m, months: 3, tolerance: 0.99 },
    { key: "semiannual", priceUsd: cfg.price6m, months: 6, tolerance: 0.99 },
    { key: "yearly", priceUsd: cfg.price12m, months: 12, tolerance: 0.99 },
  ];
}

/**
 * Pick the best plan an `amountUsd` covers — favor the longest, but only
 * if the user paid at least `priceUsd * tolerance`. Under the smallest
 * plan returns null (caller treats as "amount too small to credit"; the
 * transfer is logged but not applied).
 */
export function selectPlanForAmount(
  amountUsd: number,
  plans: PlanDef[]
): PlanDef | null {
  const sorted = [...plans].sort((a, b) => b.months - a.months);
  for (const p of sorted) {
    if (amountUsd >= p.priceUsd * p.tolerance) return p;
  }
  return null;
}
