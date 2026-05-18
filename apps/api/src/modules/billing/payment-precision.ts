/**
 * L3 (2026-05-14): ledger amount formatter.
 *
 * Replaces `amount.toFixed(2)` everywhere user-paid USDT lands in
 * `user_payments.amount_usd`. USDT in Tron/Ethereum has 6 decimals
 * on-chain; capping at 2 silently lost up to ~$0.005 per tx and
 * created drift between `payment_transactions.amount` (truthful) and
 * `user_payments.amount_usd` (truncated). Over thousands of payments
 * the discrepancy becomes the kind of thing finance teams flag.
 *
 * Strategy:
 *   - Format with 8 decimals (enough headroom for any reasonable
 *     crypto — USDT 6, BTC 8, ETH 18 but ETH-as-USD rarely needs more
 *     than 8 in our context).
 *   - Truncate (not round) — never inflate the recorded amount; if we
 *     err, err on our side, not the customer's.
 *   - Strip trailing zeros for compact storage (`100` not `100.00000000`).
 *
 * The `user_payments.amount_usd` column is already `numeric(28, 8)` so
 * the extra precision fits without a schema change.
 */

export function formatAmountForLedger(amount: number): string {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`formatAmountForLedger: non-finite ${amount}`);
  }
  if (amount < 0) {
    throw new RangeError(
      `formatAmountForLedger: negative ${amount} — refunds use insertRefund`
    );
  }
  // Truncate (floor) to 8 decimals — `toFixed` rounds half-up which we
  // explicitly do NOT want for ledger entries.
  const scaled = Math.floor(amount * 1e8) / 1e8;
  // toFixed(8) gives a fixed 8-decimal string; strip trailing zeros and
  // an orphan dot.
  return scaled.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
