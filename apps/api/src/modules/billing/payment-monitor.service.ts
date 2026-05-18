import type { AuditService } from "../audit/audit.service.js";

import type {
  BlockchainTx,
  CryptoNetwork,
  IBlockchainProvider,
} from "./blockchain-providers.js";
import type {
  BillingRepository,
  PaymentAddressRow,
} from "./billing.repository.js";
import { formatAmountForLedger } from "./payment-precision.js";
import { periodEnd as computePeriodEnd } from "./period.js";
import {
  plansFromConfig,
  selectPlanForAmount,
  type PricingConfig,
} from "./pricing.js";

export interface PaymentMonitorConfig extends PricingConfig {
  readonly minConfirmationsTrc20: number;
  readonly minConfirmationsErc20: number;
}

/**
 * Scans all active receive addresses for incoming USDT transfers, records
 * them in `payment_transactions`, and credits subscriptions for transfers
 * that cross both the confirmation threshold and a known plan price.
 *
 * Called from a BullMQ cron job in the worker process (every 5 min).
 */
export class PaymentMonitorService {
  constructor(
    private readonly repo: BillingRepository,
    private readonly providers: IBlockchainProvider[],
    private readonly audit: AuditService,
    private readonly cfg: PaymentMonitorConfig
  ) {}

  async scan(): Promise<{ scanned: number; observed: number; credited: number }> {
    const addresses = await this.repo.listActiveAddresses();
    let observed = 0;
    let scanned = 0;

    for (const addr of addresses) {
      const provider = this.providers.find((p) => p.network === addr.network);
      if (!provider) continue;
      scanned += 1;
      const txs = await this.safeFetch(provider, addr);
      for (const tx of txs) {
        await this.repo.upsertTx({
          addressId: addr.id,
          network: addr.network as CryptoNetwork,
          txHash: tx.txHash,
          fromAddress: tx.fromAddress,
          amount: tx.amount,
          confirmations: tx.confirmations,
        });
        observed += 1;
      }
    }

    // Credit ready-to-credit observed-but-not-credited rows.
    const credited = await this.creditReady();

    return { scanned, observed, credited };
  }

  private async safeFetch(
    provider: IBlockchainProvider,
    addr: PaymentAddressRow
  ): Promise<BlockchainTx[]> {
    try {
      return await provider.fetchIncoming(addr.address);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.audit.log({
        actorUserId: null,
        action: "billing.provider_error",
        target: addr.address,
        payload: { network: addr.network, error: msg.slice(0, 500) },
      });
      return [];
    }
  }

  private async creditReady(): Promise<number> {
    const ready = await this.repo.findUncreditedTxsReady(
      this.cfg.minConfirmationsTrc20,
      this.cfg.minConfirmationsErc20
    );
    if (ready.length === 0) return 0;

    const plans = plansFromConfig(this.cfg);
    let credited = 0;
    for (const tx of ready) {
      // Need (address.user_id) — re-fetch via repo to keep the SQL surface
      // minimal. Could be a join, but ready-list is tiny per scan tick.
      const addresses = await this.repo.listActiveAddresses();
      const addr = addresses.find((a) => a.id === tx.addressId);
      if (!addr) continue;

      const amount = Number(tx.amount);
      const plan = selectPlanForAmount(amount, plans);
      if (!plan) continue; // amount under smallest plan — leave as observed-only

      // M5 (2026-05-14): detect overpay. If the user sent more than the
      // selected plan's price, the surplus is recorded in audit + the
      // payment note. Admin can manually credit it back via /admin (or
      // a future "redeem overpay" automated flow). The previous
      // implementation silently lost the surplus to the operator —
      // user-hostile and would block on review by EU consumer-rights
      // regulators if ever escalated.
      const overpay = Math.max(0, amount - plan.priceUsd);
      const overpayNote = overpay > 0.005
        ? ` (overpay $${overpay.toFixed(2)} — recorded for admin review)`
        : "";

      // Extend from current period end if still active, else from now.
      // Real calendar months (B2): 30-day approximation removed.
      const current = await this.repo.latestActiveSubscription(addr.userId);
      const nowDate = new Date();
      const fromDate =
        current?.periodEnd && current.periodEnd.getTime() > nowDate.getTime()
          ? current.periodEnd
          : nowDate;
      const periodEnd = computePeriodEnd(fromDate, plan.months);

      const payment = await this.repo.creditPayment({
        userId: addr.userId,
        // L3: full USDT precision (was toFixed(2) — silently lost up
        // to ~$0.005 per tx, drift vs on-chain truth).
        amountUsd: formatAmountForLedger(amount),
        horizonMonths: plan.months,
        plan: plan.key,
        paymentMethod:
          addr.network === "trc20"
            ? "crypto_usdt_trc20"
            : "crypto_usdt_erc20",
        note: `Auto-credit from ${tx.network} tx ${tx.txHash.slice(0, 16)}…${overpayNote}`,
        periodEnd,
        txId: tx.id,
      });
      credited += 1;

      await this.audit.log({
        actorUserId: addr.userId,
        action: "billing.credited_auto",
        targetUserId: addr.userId,
        payload: {
          paymentId: payment.id,
          txId: tx.id,
          network: tx.network,
          txHash: tx.txHash,
          amount: tx.amount,
          plan: plan.key,
          planPriceUsd: plan.priceUsd,
          overpayUsd: overpay > 0 ? overpay : 0,
          periodEnd: periodEnd.toISOString(),
        },
      });

      // M5: separate explicit audit row when there's an overpay so the
      // admin "Биллинг" dashboard can filter for it.
      if (overpay > 0.005) {
        await this.audit.log({
          actorUserId: addr.userId,
          action: "billing.overpay_recorded",
          targetUserId: addr.userId,
          payload: {
            paymentId: payment.id,
            txId: tx.id,
            paidUsd: amount,
            planPriceUsd: plan.priceUsd,
            overpayUsd: overpay,
          },
        });
      }
    }
    return credited;
  }
}
