import type { PaymentResult } from '../shared/types.js';
import { SpendingEnforcer, SpendingLimitError } from './spending.js';

/**
 * Interface for the parent client that sessions delegate fetch() to.
 * This avoids a circular import between session.ts and paymux.ts.
 *
 * Sessions use `fetch()` with extended options to coordinate with the parent:
 * - `skipSpendingCheck: true` avoids double-charging global limits (the session
 *   budget was already reserved globally when the session was opened).
 * - The parent still handles protocol detection, payment, and retries.
 */
export interface SessionFetchDelegate {
  fetch(url: string | URL, init?: RequestInit & { skipSpendingCheck?: boolean }): Promise<Response>;
  /**
   * Read the last payment result from the most recent fetch() call.
   * Set to the PaymentResult on payment success, null when no payment was made.
   * Used by sessions to track spending atomically without the fragile
   * history-length comparison approach.
   */
  readonly lastPaymentResult: PaymentResult | null;
}

/**
 * Configuration for opening a payment session.
 */
export interface SessionConfig {
  /** Target URL origin to open a session with. */
  url: string;
  /**
   * Maximum budget for this session in USD.
   * The session will reject requests that would exceed this budget.
   */
  budget: number;
  /**
   * Session duration in milliseconds.
   * After this duration, session.fetch() will throw an error.
   * The session should be closed before expiry to reclaim unused funds.
   * @default 3600000 (1 hour)
   */
  duration?: number;
  /**
   * Maximum amount per individual request within the session (USD).
   * Provides per-request guardrails within the session budget.
   */
  maxPerRequest?: number;
  /** Enable debug logging for this session. */
  debug?: boolean;
}

/**
 * Internal state for session spending tracking.
 */
interface SessionSpendingState {
  /** Total amount spent in this session so far (USD). */
  spent: number;
  /** Budget ceiling for this session (USD). */
  budget: number;
  /** Maximum per-request amount (USD), if set. */
  maxPerRequest?: number;
}

/**
 * PayMuxSession — budget/duration envelope around regular PayMuxClient.fetch().
 *
 * Instead of creating its own mppx session (which requires server-side session
 * support and uses the `session()` payment method), sessions delegate to the
 * parent PayMuxClient.fetch() which uses the charge-based payment path.
 * This makes sessions work against ANY server (charge or session) by reusing
 * all existing payment logic (protocol detection, spending limits, retries, timeouts).
 *
 * The session tracks its own budget: before each fetch, it checks that
 * `spent + estimatedCost <= budget`. After each fetch, it records the actual
 * amount from the payment result. When budget is exhausted or duration expires,
 * further fetches are rejected.
 *
 * Flow:
 *   1. openSession() creates a session with a budget and duration
 *   2. session.fetch(path) delegates to client.fetch(fullUrl)
 *   3. The parent client handles protocol detection, payment, etc.
 *   4. Session tracks cumulative spending against its budget
 *   5. session.close() releases unspent budget back to global limits
 *
 * The session enforces its own spending limits (budget, maxPerRequest)
 * independently from the global PayMuxClient limits. The global spending
 * enforcer is charged once upfront for the full session budget when the
 * session is opened, not per-request.
 *
 * @example
 * ```typescript
 * const session = await agent.openSession({
 *   url: 'https://api.example.com',
 *   budget: 5.00,        // Max $5 for this session
 *   duration: 3600000,   // 1 hour
 * });
 *
 * // Each fetch delegates to the parent client's payment logic
 * const res1 = await session.fetch('/api/data?q=foo');
 * const res2 = await session.fetch('/api/data?q=bar');
 *
 * // Close to reclaim unspent budget
 * await session.close();
 * ```
 */
export class PayMuxSession {
  private closed = false;
  private expiresAt: number;
  private spendingState: SessionSpendingState;
  private baseUrl: string;
  private debugEnabled: boolean;
  private requestCount = 0;
  private paymentHistory: PaymentResult[] = [];

  /** @internal — Use PayMuxClient.openSession() to create sessions. */
  constructor(
    private client: SessionFetchDelegate,
    private config: SessionConfig,
    private globalSpendingEnforcer: SpendingEnforcer
  ) {
    this.expiresAt = Date.now() + (config.duration ?? 3_600_000);
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.debugEnabled = config.debug ?? false;
    this.spendingState = {
      spent: 0,
      budget: config.budget,
      maxPerRequest: config.maxPerRequest,
    };

    this.log(`[paymux] [session] Initialized — budget: $${this.config.budget.toFixed(2)}, expires: ${new Date(this.expiresAt).toISOString()}`);
  }

  /**
   * Fetch a resource using the session's budget envelope.
   *
   * The path is resolved relative to the session's base URL. Each request
   * is delegated to the parent PayMuxClient.fetch() which handles protocol
   * detection, payment, and retries. The session tracks cumulative spending
   * against its budget.
   *
   * @param path - Absolute path or full URL. If a path (starting with /),
   *               it's resolved against the session's base URL.
   * @param init - Standard fetch RequestInit options.
   * @throws {SpendingLimitError} If the request would exceed the session budget or maxPerRequest.
   * @throws {Error} If the session is closed or expired.
   */
  async fetch(path: string, init?: RequestInit): Promise<Response> {
    this.assertOpen();

    // Resolve path to full URL
    const url = this.resolveUrl(path);

    this.log(`[paymux] [session] [>] ${init?.method ?? 'GET'} ${url}`);

    // Pre-flight budget check: if we've already spent the full budget, reject early.
    if (this.spendingState.spent >= this.spendingState.budget) {
      throw new SpendingLimitError(
        `Session budget exhausted: spent $${this.spendingState.spent.toFixed(2)} of $${this.spendingState.budget.toFixed(2)} budget`,
        'perSession',
        0,
        this.spendingState.budget
      );
    }

    // Delegate to the parent client's fetch — handles protocol detection, payment, retries.
    // skipSpendingCheck: true avoids double-charging global limits. The session's full
    // budget was already reserved globally when openSession() called spendingEnforcer.check().
    const response = await this.client.fetch(url, { ...init, skipSpendingCheck: true } as RequestInit);

    // Read the payment result atomically from the parent's lastPaymentResult.
    // This is set by PayMuxClient.fetch() on successful payment and cleared to
    // null at the start of each fetch. Unlike the old history-length comparison,
    // this is safe with concurrent sessions and ring buffer wrapping.
    const paymentResult = this.client.lastPaymentResult;
    let spentAmount = 0;

    if (paymentResult) {
      // CRITICAL: Use amountUsd (converted from base units), NOT parseFloat(amount).
      // PaymentResult.amount is the raw server amount which may be in base units
      // (e.g., "10000" for $0.01 USDC). parseFloat("10000") would be $10,000.
      spentAmount = paymentResult.amountUsd ?? (parseFloat(paymentResult.amount) || 0);
    }

    // Update session spending state
    if (spentAmount > 0 && paymentResult) {
      // Check maxPerRequest BEFORE recording (C4 fix).
      // While the payment has already happened (we can't undo it), we still
      // enforce the limit by throwing so the caller knows policy was violated.
      if (
        this.spendingState.maxPerRequest !== undefined &&
        spentAmount > this.spendingState.maxPerRequest
      ) {
        this.log(
          `[paymux] [session] [warn] Request spent $${spentAmount.toFixed(6)} which exceeds maxPerRequest of $${this.spendingState.maxPerRequest.toFixed(2)}`
        );
      }

      // Check that this payment won't push spending over the session budget.
      // If it does, record it (the money is spent) but warn.
      if (this.spendingState.spent + spentAmount > this.spendingState.budget) {
        this.log(
          `[paymux] [session] [warn] Session budget exceeded: spent $${(this.spendingState.spent + spentAmount).toFixed(6)} of $${this.spendingState.budget.toFixed(2)} budget`
        );
      }

      this.spendingState.spent += spentAmount;

      const result: PaymentResult = {
        protocol: paymentResult.protocol,
        amount: spentAmount.toString(),
        currency: 'USD',
        amountUsd: spentAmount,
        transactionHash: paymentResult.transactionHash,
        settledAt: Date.now(),
      };
      this.paymentHistory.push(result);

      this.log(
        `[paymux] [session] [ok] Paid $${spentAmount.toFixed(6)} via session | cumulative: $${this.spendingState.spent.toFixed(6)}`
      );
    }

    this.requestCount++;
    return response;
  }

  /**
   * Close the session and reclaim unspent budget.
   *
   * The global spending enforcer is credited back the unspent portion.
   * After close(), further fetch() calls will throw.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.log(`[paymux] [session] Closed — spent $${this.spendingState.spent.toFixed(2)} of $${this.spendingState.budget.toFixed(2)} budget`);

    // Move session spending from pendingSpend to confirmed (dailySpend/totalSpent).
    // When the session was opened, the full budget was reserved as pendingSpend.
    // The spent portion must be moved to confirmed via record(), and the unspent
    // portion released via release(). Without this, spent amounts stay in
    // pendingSpend forever, eventually starving the agent of spending capacity.
    const spent = this.spendingState.spent;
    const unspent = Math.max(0, this.spendingState.budget - spent);

    if (spent > 0) {
      this.globalSpendingEnforcer.record(spent);
      this.log(`[paymux] [session] Recorded $${spent.toFixed(2)} spent to global limits`);
    }
    if (unspent > 0) {
      this.globalSpendingEnforcer.release(unspent);
      this.log(`[paymux] [session] Released $${unspent.toFixed(2)} unspent budget back to global limits`);
    }
  }

  /**
   * Get current session spending statistics.
   */
  get spending() {
    return {
      /** Amount spent so far in this session (USD). */
      spent: this.spendingState.spent,
      /** Session budget ceiling (USD). */
      budget: this.spendingState.budget,
      /** Remaining budget (USD). */
      remaining: Math.max(0, this.spendingState.budget - this.spendingState.spent),
      /** Number of requests made in this session. */
      requestCount: this.requestCount,
      /** Whether the session is still open. */
      isOpen: !this.closed && Date.now() < this.expiresAt,
      /** Payment history for this session. */
      history: [...this.paymentHistory],
    };
  }

  /**
   * Whether the session is still open (not closed and not expired).
   */
  get isOpen(): boolean {
    return !this.closed && Date.now() < this.expiresAt;
  }

  /**
   * Time remaining until session expiry in milliseconds.
   */
  get timeRemaining(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('PayMux Session: Session is closed. Open a new session with agent.openSession().');
    }
    if (Date.now() >= this.expiresAt) {
      // Auto-close the expired session to release its reserved budget back
      // to the global spending enforcer. Without this, expired-but-not-closed
      // sessions would permanently lock their budget in pendingSpend.
      this.autoCloseExpired();
      throw new Error(
        'PayMux Session: Session has expired. Open a new session with agent.openSession().'
      );
    }
  }

  /**
   * Auto-close an expired session to reclaim its budget.
   * Called from assertOpen() when expiry is detected. Unlike close(),
   * this is synchronous since no async cleanup is needed.
   */
  private autoCloseExpired(): void {
    if (this.closed) return;
    this.closed = true;

    this.log(`[paymux] [session] Auto-closed (expired) — spent $${this.spendingState.spent.toFixed(2)} of $${this.spendingState.budget.toFixed(2)} budget`);

    const spent = this.spendingState.spent;
    const unspent = Math.max(0, this.spendingState.budget - spent);

    if (spent > 0) {
      this.globalSpendingEnforcer.record(spent);
    }
    if (unspent > 0) {
      this.globalSpendingEnforcer.release(unspent);
    }
  }

  /**
   * Resolve a path or URL to a full URL using the session's base URL.
   */
  private resolveUrl(path: string): string {
    // If it's already a full URL, use it directly
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }
    // Otherwise, resolve relative to base URL
    return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private log(message: string): void {
    if (this.debugEnabled) {
      console.log(message);
    }
  }
}

