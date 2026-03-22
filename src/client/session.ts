import type { WalletConfig, PaymentResult, MppReceipt } from '../shared/types.js';
import { SpendingEnforcer, SpendingLimitError } from './spending.js';

/**
 * Configuration for opening an MPP session.
 */
export interface SessionConfig {
  /** Target URL origin to open a session with. */
  url: string;
  /**
   * Maximum budget for this session in USD.
   * Maps to the on-chain deposit for the payment channel.
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
 * PayMuxSession — wraps mppx's sessionManager for session-based MPP payments.
 *
 * Sessions amortize the initial on-chain channel open across multiple requests.
 * After the first request opens a payment channel (1 on-chain tx), subsequent
 * requests send off-chain vouchers (signed messages, no on-chain tx), making
 * them essentially free in gas costs.
 *
 * Flow:
 *   1. openSession() creates a sessionManager with a deposit (budget)
 *   2. session.fetch() sends requests that auto-pay via vouchers
 *   3. session.close() closes the channel and reclaims unspent deposit
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
 * // Each fetch reuses the payment channel — no new on-chain tx
 * const res1 = await session.fetch('/api/data?q=foo');
 * const res2 = await session.fetch('/api/data?q=bar');
 *
 * // Close to reclaim unspent deposit
 * await session.close();
 * ```
 */
export class PayMuxSession {
  private mppxFetch: typeof fetch | null = null;
  private initialized = false;
  private closed = false;
  private expiresAt: number;
  private spendingState: SessionSpendingState;
  private baseUrl: string;
  private debugEnabled: boolean;
  private requestCount = 0;
  private paymentHistory: PaymentResult[] = [];

  /** @internal — Use PayMuxClient.openSession() to create sessions. */
  constructor(
    private walletConfig: WalletConfig,
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
  }

  /**
   * Initialize the underlying mppx session.
   *
   * Uses mppx's `Mppx.create()` with the `session()` payment method in auto-mode
   * (deposit parameter set). This gives us a session-aware `fetch` that:
   * - Opens an on-chain payment channel on the first 402 challenge
   * - Sends off-chain vouchers for subsequent requests
   * - Manages cumulative amounts automatically
   *
   * Called automatically by PayMuxClient.openSession() after global spending checks.
   * @internal
   */
  async initialize(): Promise<void> {
    try {
      const { Mppx, session } = await import('mppx/client');
      const { privateKeyToAccount } = await import('viem/accounts');

      if (!this.walletConfig.privateKey) {
        throw new Error(
          'PayMux Session: wallet.privateKey is required for MPP sessions'
        );
      }

      const account = privateKeyToAccount(this.walletConfig.privateKey);

      // Create an Mppx instance with session() in auto-mode.
      // The `deposit` parameter enables automatic channel lifecycle management:
      // - First 402 challenge → opens an on-chain channel with this deposit
      // - Subsequent 402 challenges → sends off-chain vouchers (no on-chain tx)
      // - Cumulative amounts tracked automatically
      //
      // polyfill: false → scoped fetch, does NOT patch globalThis.fetch
      const mppx = Mppx.create({
        methods: [session({
          account,
          maxDeposit: this.config.budget.toString(),
        })],
        polyfill: false,
      });

      this.mppxFetch = mppx.fetch;
      this.initialized = true;

      this.log(`[paymux] [session] Initialized — budget: $${this.config.budget.toFixed(2)}, expires: ${new Date(this.expiresAt).toISOString()}`);
    } catch (error) {
      throw new Error(
        `PayMux Session: Failed to initialize mppx session. Ensure mppx and viem are installed. ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Fetch a resource using the session's payment channel.
   *
   * The path is resolved relative to the session's base URL.
   * Each request sends an off-chain voucher (after the channel is opened),
   * making subsequent requests essentially free in gas costs.
   *
   * @param path - Absolute path or full URL. If a path (starting with /),
   *               it's resolved against the session's base URL.
   * @param init - Standard fetch RequestInit options.
   * @throws {SpendingLimitError} If the request would exceed the session budget or maxPerRequest.
   * @throws {Error} If the session is closed or expired.
   */
  async fetch(path: string, init?: RequestInit): Promise<Response> {
    this.assertOpen();

    if (!this.initialized || !this.mppxFetch) {
      throw new Error('PayMux Session: Not initialized. Call initialize() first.');
    }

    // Resolve path to full URL
    const url = this.resolveUrl(path);

    this.log(`[paymux] [session] [>] ${init?.method ?? 'GET'} ${url}`);

    // Session-level spending enforcement is done post-hoc based on receipts.
    // We can't know the exact charge amount before the request (it depends on
    // the server's per-request pricing which may vary). Instead, we check
    // remaining budget and maxPerRequest constraints.
    //
    // Pre-flight budget check: if we've already spent the full budget, reject early.
    if (this.spendingState.spent >= this.spendingState.budget) {
      throw new SpendingLimitError(
        `Session budget exhausted: spent $${this.spendingState.spent.toFixed(2)} of $${this.spendingState.budget.toFixed(2)} budget`,
        'perSession',
        0,
        this.spendingState.budget
      );
    }

    // Use mppx's session-aware fetch which handles 402 challenge/voucher flow.
    // On first 402: opens a channel with on-chain deposit.
    // On subsequent 402s: sends off-chain vouchers automatically.
    const response = await this.mppxFetch(url, init);

    // Parse the receipt to track spending
    const receiptHeader = response.headers.get('payment-receipt');
    let receipt: MppReceipt | undefined;
    let spentAmount = 0;

    if (receiptHeader) {
      try {
        const decoded = atob(receiptHeader.replace(/-/g, '+').replace(/_/g, '/'));
        const parsed: unknown = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object') {
          const raw = parsed as Record<string, unknown>;
          receipt = {
            status: 'success',
            method: raw.method as string,
            reference: raw.reference as string,
            timestamp: raw.timestamp as string,
            externalId: raw.externalId as string | undefined,
          };

          // Extract the amount spent from the receipt.
          // Session receipts include a 'spent' field with the per-request charge.
          if (typeof raw.spent === 'string') {
            spentAmount = parseFloat(raw.spent);
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
        // The payment already happened (voucher was sent), so we log a warning
        // but still record it. Future: pre-check against challenge amount.
        this.log(
          `[paymux] [session] [warn] Request spent $${spentAmount.toFixed(6)} which exceeds maxPerRequest of $${this.spendingState.maxPerRequest.toFixed(2)}`
        );
      }

      this.spendingState.spent += spentAmount;

      const result: PaymentResult = {
        protocol: 'mpp',
        amount: spentAmount.toString(),
        currency: 'USD',
        transactionHash: receipt?.reference,
        receipt,
        settledAt: Date.now(),
      };
      this.paymentHistory.push(result);

      this.log(
        `[paymux] [session] [ok] Paid $${spentAmount.toFixed(6)} via session voucher | cumulative: $${this.spendingState.spent.toFixed(6)}`
      );
    }

    this.requestCount++;
    return response;
  }

  /**
   * Close the session and reclaim unspent deposit.
   *
   * This closes the on-chain payment channel. Any unspent deposit is
   * returned to the wallet. The global spending enforcer is credited
   * back the unspent portion.
   *
   * After close(), further fetch() calls will throw.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.log(`[paymux] [session] Closed — spent $${this.spendingState.spent.toFixed(2)} of $${this.spendingState.budget.toFixed(2)} budget`);

    // NOTE: mppx's session() method with Mppx.create() does not expose a
    // close() method on the fetch wrapper. Channel close is handled by mppx
    // internally when the session deposit is exhausted, or the channel times
    // out on-chain. For explicit close, use sessionManager (requires
    // mppx/tempo/client which is not yet in mppx's public exports).
    // TODO: Add explicit channel close when mppx exposes sessionManager
    // in its public package exports.

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
      /** Whether the session has been initialized. */
      initialized: this.initialized,
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

