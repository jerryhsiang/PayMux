import type { SpendingLimits } from '../shared/types.js';

/**
 * Spending enforcer — tracks and enforces payment limits.
 *
 * Uses optimistic locking via pending amounts to handle concurrent requests.
 * When check() is called, the amount is added to pendingSpend.
 * When record() is called, it moves from pending to confirmed.
 * When reject() is called (payment failed), it releases the pending amount.
 */
export class SpendingEnforcer {
  private dailySpend = 0;
  private pendingSpend = 0;
  private totalSpent = 0;
  private dailyResetAt: number;

  constructor(private limits: SpendingLimits) {
    this.dailyResetAt = Date.now() + 24 * 60 * 60 * 1000;
  }

  /**
   * Check if a payment amount is within limits and reserve it.
   * The amount is held as "pending" until record() or release() is called.
   * Throws if the payment would exceed any limit.
   */
  check(amount: number): void {
    this.resetDailyIfNeeded();

    // Per-request limit
    if (this.limits.perRequest !== undefined && amount > this.limits.perRequest) {
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
        this.limits.perDay
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
  }

  /**
   * Record a completed payment — moves amount from pending to confirmed
   */
  record(amount: number): void {
    this.resetDailyIfNeeded();
    this.pendingSpend = Math.max(0, this.pendingSpend - amount);
    this.dailySpend += amount;
    this.totalSpent += amount;
  }

  /**
   * Release a pending amount (payment failed or was cancelled)
   */
  release(amount: number): void {
    this.pendingSpend = Math.max(0, this.pendingSpend - amount);
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
    if (Date.now() > this.dailyResetAt) {
      this.dailySpend = 0;
      this.pendingSpend = 0;
      this.dailyResetAt = Date.now() + 24 * 60 * 60 * 1000;
    }
  }
}

/**
 * Error thrown when a spending limit is exceeded
 */
export class SpendingLimitError extends Error {
  constructor(
    message: string,
    public readonly limitType: 'perRequest' | 'perDay' | 'perSession' | 'requireApproval',
    public readonly requestedAmount: number,
    public readonly limit: number
  ) {
    super(message);
    this.name = 'SpendingLimitError';
  }
}
