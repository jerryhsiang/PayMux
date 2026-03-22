import type { PaymentResult } from '../shared/types.js';
import { SpendingEnforcer, SpendingLimitError } from './spending.js';

/**
 * Interface for the parent client that sessions delegate fetch() to.
 * This avoids a circular import between session.ts and paymux.ts.
 */
export interface SessionFetchDelegate {
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
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
    const response = await this.client.fetch(url, init);

    // Parse the receipt to track spending within the session
    const receiptHeader = response.headers.get('payment-receipt');
    let spentAmount = 0;

    if (receiptHeader) {
      try {
        const decoded = atob(receiptHeader.replace(/-/g, '+').replace(/_/g, '/'));
        const parsed: unknown = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object') {
          const raw = parsed as Record<string, unknown>;

          // Extract the amount spent from the receipt.
          // Receipts may include a 'spent' or 'amount' field with the per-request charge.
          if (typeof raw.spent === 'string') {
            spentAmount = parseFloat(raw.spent);
          } else if (typeof raw.amount === 'string') {
            spentAmount = parseFloat(raw.amount);
          }
        }
      } catch {
        // Receipt parsing failed — non-critical
      }
    }

    // Update session spending state
    if (spentAmount > 0) {
      // Check maxPerRequest if configured
      if (
        this.spendingState.maxPerRequest !== undefined &&
        spentAmount > this.spendingState.maxPerRequest
      ) {
        // The payment already happened, so we log a warning but still record it.
        this.log(
          `[paymux] [session] [warn] Request spent $${spentAmount.toFixed(6)} which exceeds maxPerRequest of $${this.spendingState.maxPerRequest.toFixed(2)}`
        );
      }

      this.spendingState.spent += spentAmount;

      const result: PaymentResult = {
        protocol: 'mpp',
        amount: spentAmount.toString(),
        currency: 'USD',
        transactionHash: undefined,
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

    // Credit back unspent budget to the global spending enforcer.
    // When the session was opened, the full budget was charged globally.
    // Now we release the portion that wasn't actually used.
    const unspent = Math.max(0, this.spendingState.budget - this.spendingState.spent);
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
      throw new Error(
        'PayMux Session: Session has expired. Open a new session with agent.openSession().'
      );
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

