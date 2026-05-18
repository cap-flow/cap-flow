/**
 * Calendar-month arithmetic for subscription periods.
 *
 * Replaces the legacy `from + months * 30 * 86_400_000` approximation,
 * which silently shortened every annual plan by 5 days (~1.4% of a year).
 * Public-launch billing must match real-world calendar months so users
 * always get exactly what they pay for.
 *
 * UTC-based to avoid DST drift; clamps to end-of-month when the target
 * month is shorter than the source day (Jan 31 + 1mo = Feb 28/29, NOT
 * Mar 3 which is what naive JS Date arithmetic produces).
 */

export function addMonths(from: Date, months: number): Date {
  if (!Number.isFinite(months)) {
    throw new TypeError(`addMonths: invalid months value '${months}'`);
  }
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  const h = from.getUTCHours();
  const mi = from.getUTCMinutes();
  const s = from.getUTCSeconds();
  const ms = from.getUTCMilliseconds();

  // Step 1: build target year/month, day=1 to dodge JS overflow.
  const targetYear = y + Math.floor((m + months) / 12);
  const targetMonth = ((m + months) % 12 + 12) % 12;

  // Step 2: find how many days the target month actually has.
  // Trick: day 0 of next month = last day of target month.
  const daysInTarget = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0)
  ).getUTCDate();

  // Step 3: clamp source day to that.
  const clampedDay = Math.min(d, daysInTarget);

  return new Date(Date.UTC(targetYear, targetMonth, clampedDay, h, mi, s, ms));
}

/**
 * Compute period_end for a subscription that starts at `from` and lasts
 * `months` calendar months. Thin wrapper around `addMonths` with a
 * positive-months precondition — billing has no concept of zero-length
 * or negative periods.
 */
export function periodEnd(from: Date, months: number): Date {
  if (!Number.isInteger(months) || months <= 0) {
    throw new RangeError(
      `periodEnd: months must be a positive integer, got '${months}'`
    );
  }
  return addMonths(from, months);
}
