import type { SpendingLimits } from '../shared/types.js';

/**
 * Opaque reservation token returned by check().
 *
 * Tracks the exact amount that was reserved so that record() and release()
 * always release precisely what was checked — preventing pending-amount drift
 * when the actual payment amount differs from the probed amount.
 */
export interface SpendingReservation {
  /** The amount reserved in this check (USD). */
  readonly amount: number;
  /** Whether this reservation has already been settled (recorded or released). */
  readonly settled: boolean;
}

/**
 * Internal mutable reservation. The public interface is readonly;
 * only the SpendingEnforcer can mark it as settled.
 */
interface MutableReservation extends SpendingReservation {
  settled: boolean;
}

/**
 * Spending enforcer — tracks and enforces payment limits.
 *
 * Uses optimistic locking via pending amounts to handle concurrent requests.
 * When check() is called, the amount is added to pendingSpend and a
 * SpendingReservation token is returned. record() and release() accept the
 * reservation token to ensure the exact reserved amount is released — preventing
 * drift when the actual payment differs from the probed amount.
 *
 * Legacy record(amount)/release(amount) signatures are still supported for
 * backward compatibility (session close, etc.) but new code should prefer
 * the reservation-based overloads.
 */
export class SpendingEnforcer {
  private dailySpend = 0;
  private pendingSpend = 0;
  private totalSpent = 0;
  private dailyResetAt: number;

  constructor(private limits: SpendingLimits) {
    this.dailyResetAt = new Date().setUTCHours(24, 0, 0, 0);
  }

  /**
   * Check if a payment amount is within limits and reserve it.
   * Returns a SpendingReservation token that must be passed to record() or
   * release() to settle the reservation. This prevents pending-amount drift
   * when the actual payment amount differs from what was checked.
   *
   * Throws if the payment would exceed any limit.
   *
   * @param skipPerRequest - If true, skip the per-request limit check.
   *   Used by openSession() where the budget is an envelope, not a single request.
   */
  check(amount: number, skipPerRequest?: boolean): SpendingReservation {
    this.resetDailyIfNeeded();

    // Per-request limit
    if (!skipPerRequest && this.limits.perRequest !== undefined && amount > this.limits.perRequest) {
      throw new SpendingLimitError(
        `Payment of $${amount.toFixed(2)} exceeds per-request limit of $${this.limits.perRequest.toFixed(2)}`,
        'perRequest',
        amount,
        this.limits.perRequest
      );
    }

    // Per-day limit (includes pending amounts for concurrency safety)
    const effectiveDaily = this.dailySpend + this.pendingSpend;
    if (
      this.limits.perDay !== undefined &&
      effectiveDaily + amount > this.limits.perDay
    ) {
      throw new SpendingLimitError(
        `Payment of $${amount.toFixed(2)} would exceed daily limit of $${this.limits.perDay.toFixed(2)} (spent: $${this.dailySpend.toFixed(2)}, pending: $${this.pendingSpend.toFixed(2)})`,
        'perDay',
        amount,
        this.limits.perDay,
        effectiveDaily
      );
    }

    // Human approval threshold
    if (
      this.limits.requireApproval !== undefined &&
      amount > this.limits.requireApproval
    ) {
      throw new SpendingLimitError(
        `Payment of $${amount.toFixed(2)} requires human approval (threshold: $${this.limits.requireApproval.toFixed(2)}). Approval workflows ship in v0.5.0.`,
        'requireApproval',
        amount,
        this.limits.requireApproval
      );
    }

    // Reserve the amount as pending
    this.pendingSpend += amount;

    return { amount, settled: false } as MutableReservation;
  }

  /**
   * Record a completed payment.
   *
   * Overload 1 (preferred): Pass the reservation token. Releases the exact
   * reserved amount from pending and records `actualAmount` (or the reserved
   * amount if omitted) as confirmed spending.
   *
   * Overload 2 (legacy): Pass a raw number. Releases that amount from pending
   * and records it as confirmed. Used by session close() which tracks its own
   * spending separately.
   */
  record(reservationOrAmount: SpendingReservation | number, actualAmount?: number): void {
    this.resetDailyIfNeeded();

    if (typeof reservationOrAmount === 'number') {
      // Legacy path: raw number
      const amount = reservationOrAmount;
      this.pendingSpend = Math.max(0, this.pendingSpend - amount);
      this.dailySpend += amount;
      this.totalSpent += amount;
      return;
    }

    // Reservation-based path
    const reservation = reservationOrAmount as MutableReservation;
    if (reservation.settled) return; // Idempotent — already settled
    reservation.settled = true;

    // Release the exact reserved amount from pending
    this.pendingSpend = Math.max(0, this.pendingSpend - reservation.amount);

    // Record the actual amount spent (may differ from the reserved amount
    // if the server changed the price between probe and payment)
    const confirmed = actualAmount ?? reservation.amount;
    this.dailySpend += confirmed;
    this.totalSpent += confirmed;
  }

  /**
   * Release a pending amount (payment failed or was cancelled).
   *
   * Overload 1 (preferred): Pass the reservation token.
   * Overload 2 (legacy): Pass a raw number.
   */
  release(reservationOrAmount: SpendingReservation | number): void {
    if (typeof reservationOrAmount === 'number') {
      // Legacy path: raw number
      this.pendingSpend = Math.max(0, this.pendingSpend - reservationOrAmount);
      return;
    }

    // Reservation-based path
    const reservation = reservationOrAmount as MutableReservation;
    if (reservation.settled) return; // Idempotent — already settled
    reservation.settled = true;

    this.pendingSpend = Math.max(0, this.pendingSpend - reservation.amount);
  }

  /**
   * Update spending limits at runtime.
   * Does NOT reset current spend — only changes future limit checks.
   * Useful for external systems that manage agent budgets.
   */
  updateLimits(limits: SpendingLimits): void {
    this.limits = limits;
  }

  /**
   * Get current spending stats
   */
  stats(): {
    dailySpend: number;
    pendingSpend: number;
    dailyLimit?: number;
    dailyRemaining?: number;
    totalSpent: number;
  } {
    this.resetDailyIfNeeded();
    return {
      dailySpend: this.dailySpend,
      pendingSpend: this.pendingSpend,
      dailyLimit: this.limits.perDay,
      dailyRemaining:
        this.limits.perDay !== undefined
          ? Math.max(0, this.limits.perDay - this.dailySpend - this.pendingSpend)
          : undefined,
      totalSpent: this.totalSpent,
    };
  }

  private resetDailyIfNeeded(): void {
    if (Date.now() >= this.dailyResetAt) {
      this.dailySpend = 0;
      // Also reset pending carry-over from the previous day.
      // Pending amounts from yesterday should not reduce today's capacity.
      // If a payment from yesterday eventually settles, record() will add it
      // to dailySpend (which is acceptable — conservative over-counting).
      this.pendingSpend = 0;
      this.dailyResetAt = new Date().setUTCHours(24, 0, 0, 0);
    }
  }
}

/**
 * Error thrown when a spending limit is exceeded
 */
export class SpendingLimitError extends Error {
  /**
   * Current daily spend when the error was thrown (USD).
   * Only populated for perDay limit errors; undefined for other limit types.
   */
  public readonly currentSpent?: number;

  constructor(
    message: string,
    public readonly limitType: 'perRequest' | 'perDay' | 'perSession' | 'requireApproval',
    public readonly requestedAmount: number,
    public readonly limit: number,
    currentSpent?: number
  ) {
    super(message);
    this.name = 'SpendingLimitError';
    this.currentSpent = currentSpent;
  }
}
