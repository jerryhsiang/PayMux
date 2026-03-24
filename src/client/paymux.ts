import type { PayMuxConfig, PayMuxFetchOptions } from './types.js';
import type { PaymentRequirement, PaymentResult, SpendingLimits, Protocol } from '../shared/types.js';
import type { PayMuxLogger } from './logger.js';
import { resolveLogger } from './logger.js';
import { detectProtocol, selectBestRequirement } from './protocols/detector.js';
import { X402Client } from './protocols/x402.js';
import { MppClient, MppTimeoutError } from './protocols/mpp.js';
import { SpendingEnforcer } from './spending.js';
import type { SpendingReservation } from './spending.js';
import { verifyAmountConsistency, getTokenName } from './utils.js';
import { probeMppAmount } from './protocols/mpp-probe.js';
import { PayMuxSession } from './session.js';
import type { SessionConfig } from './session.js';

/**
 * Cached protocol detection result for a URL.
 *
 * After the first probe detects a protocol for a given URL, we cache the
 * mapping so subsequent requests skip the full protocol detection logic.
 * For MPP: cached URLs go through a lightweight MPP-specific probe to
 * extract the payment amount, enforce spending limits, then delegate to
 * mppx.fetch(). This ensures spending limits are always checked BEFORE
 * payment, while skipping the heavier multi-protocol detection.
 */
interface CachedProtocol {
  protocol: Protocol;
  /** Timestamp of when this entry was cached (ms since epoch) */
  cachedAt: number;
}

/**
 * PayMux — Multi-protocol payment routing for AI agents.
 *
 * @example
 * ```typescript
 * import { PayMux } from 'paymux';
 *
 * const agent = PayMux.create({
 *   wallet: { privateKey: '0x...' },
 *   limits: { perRequest: 1.00, perDay: 200.00 },
 * });
 *
 * // Works with BOTH x402 and MPP endpoints — auto-detects protocol
 * const response = await agent.fetch('https://api.example.com/data');
 * ```
 */
export class PayMux {
  static create(config: PayMuxConfig): PayMuxClient {
    return new PayMuxClient(config);
  }
}

/**
 * PayMux client instance — handles auto-detection, routing, and payment.
 *
 * Architecture: Probe-first for protocol detection + spending enforcement.
 *
 * Flow (x402):
 * 1. Send probe request (plain fetch) — 1 HTTP call
 * 2. If non-402, return immediately (zero overhead)
 * 3. If 402, detect protocol + extract amount + convert to USD
 * 4. Enforce spending limits (per-request, per-day, maxAmount) — all in USD
 * 5. Sign payment locally (pure crypto, no HTTP call)
 * 6. Retry with payment proof — 1 HTTP call
 * 7. Total: 2 HTTP calls for paid requests (probe + paid retry)
 *
 * Flow (MPP — first call to a URL):
 * 1. PayMux probe detects MPP protocol — 1 HTTP call (402)
 * 2. Protocol is cached for this URL
 * 3. mppx.fetch() runs its own probe + paid retry — 2 HTTP calls
 * 4. Total: 3 HTTP calls (first call only)
 *
 * Flow (MPP — subsequent calls to a cached URL):
 * 1. Protocol cache hit — skip full protocol detection
 * 2. MPP-specific probe to extract amount — 1 HTTP call
 * 3. Enforce spending limits BEFORE payment
 * 4. mppx.fetch() runs its own probe + paid retry — 2 HTTP calls
 * 5. Total: 3 HTTP calls (same as first call, but skips protocol detection)
 *
 * For x402: signs directly from the probe's PAYMENT-REQUIRED header using
 * @x402/core (bypasses wrapFetchWithPayment which would make a redundant request).
 * For MPP: mppx.fetch() handles its own 402 challenge/response flow. After the
 * first probe detects MPP, the URL→protocol mapping is cached so subsequent
 * requests skip the full protocol detection logic and go directly to an
 * MPP-specific probe + spending limit check + mppx.fetch().
 */
export class PayMuxClient {
  private x402Client: X402Client | null = null;
  private mppClient: MppClient | null = null;
  private spendingEnforcer: SpendingEnforcer;
  private config: PayMuxConfig;
  private logger: PayMuxLogger;
  private paymentHistory: (PaymentResult | undefined)[];
  private historyHead: number = 0;
  private historyCount: number = 0;
  private static readonly MAX_HISTORY = 10_000;
  private activeSessions: PayMuxSession[] = [];

  /**
   * Last payment result from the most recent fetch() call.
   * Used by sessions to atomically read the payment result without
   * the fragile history-length comparison approach.
   *
   * Set to the PaymentResult before recordPayment() and cleared to null
   * before each new fetch() starts. Sessions read this immediately after
   * their delegated fetch() returns.
   */
  private _lastPaymentResult: PaymentResult | null = null;

  /**
   * @internal — Read the last payment result from the most recent fetch().
   * Used by PayMuxSession to track spending without comparing history lengths.
   */
  get lastPaymentResult(): PaymentResult | null {
    return this._lastPaymentResult;
  }

  /**
   * Protocol cache: maps URL origins+pathnames to detected protocols.
   *
   * Purpose: After the first probe detects that a URL speaks MPP, we cache
   * this so subsequent requests skip the PayMux probe and go directly to
   * mppx.fetch(), which does its own probe internally. This eliminates the
   * redundant third HTTP call on repeat requests.
   *
   * Cache key: URL origin + pathname (query params stripped so
   * `api.example.com/data?page=1` and `api.example.com/data?page=2`
   * share the same cache entry).
   *
   * TTL: 5 minutes. Servers can change their payment requirements, so
   * we re-probe periodically to stay in sync.
   */
  private protocolCache = new Map<string, CachedProtocol>();
  private static readonly PROTOCOL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly MAX_CACHE_ENTRIES = 1000;

  /** Resolved retry config. null means retries are disabled. */
  private retryConfig: {
    maxRetries: number;
    baseDelayMs: number;
    retryableStatusCodes: number[];
    retryMethods: string[];
  } | null;

  /** Timeout for protocol-detection probes (default: 10s) */
  private probeTimeoutMs: number;
  /** Timeout for payment settlement calls (default: 30s) */
  private paymentTimeoutMs: number;

  constructor(config: PayMuxConfig) {
    this.config = config;
    this.logger = resolveLogger({ debug: config.debug, logger: config.logger });
    this.spendingEnforcer = new SpendingEnforcer(config.limits ?? {});
    this.paymentHistory = new Array(PayMuxClient.MAX_HISTORY);

    // Resolve timeout config
    this.probeTimeoutMs = config.timeouts?.probeMs ?? 10_000;
    this.paymentTimeoutMs = config.timeouts?.paymentMs ?? 30_000;

    // Resolve retry config
    if (config.retry === false) {
      this.retryConfig = null;
    } else {
      const rc = config.retry ?? {};
      this.retryConfig = {
        maxRetries: rc.maxRetries ?? 2,
        baseDelayMs: rc.baseDelayMs ?? 1000,
        retryableStatusCodes: rc.retryableStatusCodes ?? [502, 503, 504],
        retryMethods: (rc.retryMethods ?? ['GET', 'HEAD']).map(m => m.toUpperCase()),
      };
    }

    if (config.wallet?.privateKey) {
      this.x402Client = new X402Client(config.wallet, this.paymentTimeoutMs);
      this.mppClient = new MppClient(config.wallet, this.paymentTimeoutMs);
    } else if (config.wallet?.privy || config.wallet?.coinbase) {
      this.logger.warn(
        '[paymux] [warn] wallet.privy and wallet.coinbase are not yet supported. Only wallet.privateKey is currently implemented.',
        { unsupportedWallet: config.wallet.privy ? 'privy' : 'coinbase' }
      );
    }
  }

  /**
   * Fetch a resource, automatically handling payment if required.
   *
   * @throws {SpendingLimitError} If payment exceeds configured limits
   * @throws {Error} If payment fails or no wallet configured
   */
  async fetch(
    url: string | URL,
    init?: PayMuxFetchOptions
  ): Promise<Response> {
    const urlString = url.toString();
    const options = init ?? {};
    const { maxAmount, protocol, skipPayment, skipSpendingCheck, ...fetchInit } = options;

    // Clear last payment result at the start of each fetch so sessions
    // can distinguish "no payment" from "payment" by checking lastPaymentResult.
    this._lastPaymentResult = null;

    if (skipPayment) {
      return globalThis.fetch(urlString, fetchInit);
    }

    this.logger.debug(`[paymux] [>] ${fetchInit.method ?? 'GET'} ${urlString}`, {
      event: 'request_start', method: fetchInit.method ?? 'GET', url: urlString,
    });

    // ── MPP fast path: skip full protocol detection for cached MPP URLs ─
    // After the first request to a URL detects MPP, we cache the mapping.
    // On subsequent requests, we skip the full PayMux protocol detection
    // (which parses x402 headers, body, etc.) and go directly to an
    // MPP-specific probe that extracts the payment amount, enforces
    // spending limits BEFORE payment, then delegates to mppx.fetch().
    //
    // We only use the fast path when:
    // - No forced protocol override (protocol option)
    // - The cache entry hasn't expired (5 minute TTL)
    // If the endpoint stops requiring payment, the probe detects this
    // and returns the non-402 response directly.
    if (!protocol) {
      const cached = this.getCachedProtocol(urlString);
      if (cached === 'mpp') {
        this.logger.debug(`[paymux] [cache] MPP cached for ${urlString} — skipping probe`, {
          event: 'cache_hit', protocol: 'mpp', url: urlString,
        });
        return this.mppFastPath(urlString, fetchInit, maxAmount, skipSpendingCheck);
      }
    }

    // ── Standard path: probe first, then route ────────────────────────

    // Step 1: Probe request to detect if payment is needed + which protocol
    // Retries on transient network errors (only for safe HTTP methods).
    const probeResponse = await this.probeWithRetry(urlString, fetchInit);

    // Step 2: If not 402, return immediately (no payment needed)
    if (probeResponse.status !== 402) {
      this.logger.debug(`[paymux] [<] ${probeResponse.status} (no payment required)`, {
        event: 'no_payment', status: probeResponse.status, url: urlString,
      });
      // If this URL was cached as a payment URL but now returns non-402,
      // evict the stale cache entry so we don't keep hitting the fast path
      this.protocolCache.delete(this.getCacheKey(urlString));
      return probeResponse;
    }

    this.logger.debug(`[paymux] [<] 402 Payment Required — detecting protocol...`, {
      event: 'payment_required', status: 402, url: urlString,
    });

    // Step 3: Detect protocol from 402 response headers/body
    const requirements = await detectProtocol(probeResponse);

    if (requirements.length === 0) {
      this.logger.error(`[paymux] [err] Could not detect payment protocol`, {
        event: 'protocol_detection_failed', url: urlString,
      });
      return probeResponse;
    }

    // Select best payment method (respects preferProtocol config + forced protocol)
    const requirement = selectBestRequirement(
      requirements,
      protocol ? [protocol] : this.config.preferProtocol
    );

    if (!requirement) {
      this.logger.error(`[paymux] [err] No supported payment method found`, {
        event: 'no_supported_method', url: urlString,
      });
      return probeResponse;
    }

    // ── Cache the detected protocol for future requests ───────────────
    // This is what enables the MPP fast path on subsequent calls.
    // We cache ALL protocols (not just MPP) so getCachedProtocol can
    // distinguish "known x402" from "unknown" — avoiding false MPP hits.
    this.setCachedProtocol(urlString, requirement.protocol);

    // CRITICAL: Use amountUsd (converted from base units) for spending checks.
    // x402 sends amounts in base units (e.g., "10000" = $0.01 for 6-decimal USDC).
    // Spending limits (perRequest, perDay, maxAmount) are all in USD.
    // Without this conversion, a $0.01 payment would be checked as 10000 > 1.00.
    const amountUsd = requirement.amountUsd ?? parseFloat(requirement.amount);
    const amountRaw = requirement.amount;

    const currencyDisplay = getTokenName(requirement.currency);
    this.logger.debug(
      `[paymux]   Protocol: ${requirement.protocol} | Amount: $${amountUsd.toFixed(6)} (raw: ${amountRaw} ${currencyDisplay})`,
      { event: 'payment_detected', protocol: requirement.protocol, amountUsd, amountRaw, currency: requirement.currency, url: urlString }
    );

    // Logic check: verify the base-unit-to-USD conversion is consistent
    if (requirement.protocol === 'x402' && requirement.amountUsd !== undefined) {
      if (!verifyAmountConsistency(amountRaw, amountUsd, requirement.asset)) {
        this.logger.warn(
          `[paymux] [warn] Amount conversion may be inconsistent: raw=${amountRaw}, usd=${amountUsd}, asset=${requirement.asset}`,
          { event: 'amount_inconsistency', amountRaw, amountUsd, asset: requirement.asset, url: urlString }
        );
      }
    }

    // Step 4: ENFORCE SPENDING LIMITS — all checks in USD
    // skipSpendingCheck: used by sessions whose budget was already reserved globally
    const shouldCheckSpending = !skipSpendingCheck;

    // maxAmount ceiling check (USD) — always enforced regardless of skipSpendingCheck
    if (maxAmount !== undefined && amountUsd > maxAmount) {
      throw new Error(
        `PayMux: Payment of $${amountUsd.toFixed(6)} exceeds maxAmount of $${maxAmount.toFixed(2)}`
      );
    }

    // Per-request + per-day limits in USD (reserves amount as pending)
    let reservation: SpendingReservation | null = null;
    if (shouldCheckSpending) {
      reservation = this.spendingEnforcer.check(amountUsd);
    }

    // Step 5: Route to protocol client — release pending on failure
    let response: Response;
    let result: PaymentResult;

    try {
      const payResult = await this.routeToClient(urlString, fetchInit, requirement, probeResponse);
      response = payResult.response;
      result = payResult.result;
    } catch (error) {
      // On MppTimeoutError, do NOT release the pending reservation.
      // The payment may still complete in the background.
      if (error instanceof MppTimeoutError) {
        this.logger.warn(
          `[paymux] [warn] MPP payment timed out — pending reservation preserved as safeguard`,
          { event: 'mpp_timeout_pending_preserved', amountUsd, url: urlString }
        );
        throw error;
      }
      // Release the pending reservation so failed payments don't
      // permanently reduce daily spending capacity
      if (reservation) {
        this.spendingEnforcer.release(reservation);
      }
      throw error;
    }

    // Step 6: Record successful payment (moves from pending to confirmed)
    // Use the reservation token so the exact reserved amount is released from
    // pending. The actual amount (amountUsd) is recorded as confirmed spending.
    if (reservation) {
      this.spendingEnforcer.record(reservation, amountUsd);
    }

    // CRITICAL: Set amountUsd on the PaymentResult so downstream consumers
    // (e.g., session spending tracking) use the converted USD amount, not raw
    // base units. Without this, parseFloat("10000") would be $10,000 not $0.01.
    result.amountUsd = amountUsd;
    this._lastPaymentResult = result;
    this.recordPayment(result);

    this.logger.info(
      `[paymux] [ok] Paid $${amountUsd.toFixed(6)} via ${result.protocol}${result.transactionHash ? ` | tx: ${result.transactionHash}` : ''}`,
      { event: 'payment_success', protocol: result.protocol, amountUsd, transactionHash: result.transactionHash, url: urlString }
    );

    return response;
  }

  /**
   * Route to the correct protocol client based on detected requirement.
   * Passes probeResponse so protocol clients can sign directly from it
   * (avoiding a redundant second probe request).
   */
  private async routeToClient(
    url: string,
    init: RequestInit,
    requirement: PaymentRequirement,
    probeResponse: Response
  ): Promise<{ response: Response; result: PaymentResult }> {
    switch (requirement.protocol) {
      case 'x402': {
        if (!this.x402Client) {
          throw new Error(
            'PayMux: x402 payment required but no wallet configured. ' +
              'Pass wallet.privateKey to PayMux.create().'
          );
        }
        if (!this.x402Client.canHandle(requirement)) {
          throw new Error(
            `PayMux: x402 cannot handle network "${requirement.network}". ` +
              'Only EVM chains are currently supported.'
          );
        }
        // Pass probeResponse so x402 client signs from its headers (no extra request)
        return this.x402Client.pay(url, init, requirement, probeResponse);
      }

      case 'mpp': {
        if (!this.mppClient) {
          throw new Error(
            'PayMux: MPP payment required but no wallet configured. ' +
              'Pass wallet.privateKey to PayMux.create().'
          );
        }
        return this.mppClient.pay(url, init, requirement);
      }

      case 'card':
        throw new Error(
          'PayMux: Card payments ship in a future release. Use x402 or MPP for now.'
        );

      default:
        throw new Error(`PayMux: Unknown protocol "${requirement.protocol}"`);
    }
  }

  /**
   * Get current spending statistics (all values in USD).
   */
  get spending() {
    const stats = this.spendingEnforcer.stats();
    const history: PaymentResult[] = [];
    for (let i = 0; i < this.historyCount; i++) {
      const idx = (this.historyHead - this.historyCount + i + PayMuxClient.MAX_HISTORY) % PayMuxClient.MAX_HISTORY;
      history.push(this.paymentHistory[idx]!);
    }
    return {
      ...stats,
      history,
      totalSpent: stats.totalSpent,
    };
  }

  /**
   * Record a payment in the ring buffer. Overwrites the oldest entry
   * when the buffer is full, avoiding array reallocation.
   */
  private recordPayment(result: PaymentResult): void {
    this.paymentHistory[this.historyHead] = result;
    this.historyHead = (this.historyHead + 1) % PayMuxClient.MAX_HISTORY;
    if (this.historyCount < PayMuxClient.MAX_HISTORY) this.historyCount++;
  }

  /**
   * Get current spending limits.
   */
  get limits(): Readonly<SpendingLimits> {
    return { ...this.config.limits } as SpendingLimits;
  }

  /**
   * Update spending limits at runtime.
   * Useful for systems that manage limits externally (e.g., a dashboard,
   * an admin API, or a parent agent that controls child agent budgets).
   *
   * @example
   * ```typescript
   * // Reduce daily limit after detecting unusual activity
   * agent.setLimits({ perRequest: 0.10, perDay: 5.00 });
   *
   * // Read current limits from an external system
   * const limits = await fetchLimitsFromDashboard(agentId);
   * agent.setLimits(limits);
   * ```
   */
  setLimits(limits: SpendingLimits): void {
    this.config = { ...this.config, limits };
    this.spendingEnforcer.updateLimits(limits);
  }


  // ── Session management ─────────────────────────────────────────────

  /**
   * Open a payment session for budget-scoped payments to a single origin.
   *
   * Sessions delegate to the parent client's fetch() for payment, which uses
   * charge-based payments. This works against ANY server (charge or session)
   * by reusing all existing payment logic (protocol detection, spending limits,
   * retries, timeouts). The session tracks cumulative spending against its budget.
   *
   * The session budget is charged against global spending limits upfront when
   * the session is opened. When the session is closed, unspent budget is
   * released back to the global limits.
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
   *
   * @throws {SpendingLimitError} If the session budget exceeds global spending limits
   * @throws {Error} If no wallet is configured
   */
  async openSession(config: SessionConfig): Promise<PayMuxSession> {
    if (!this.config.wallet?.privateKey) {
      throw new Error(
        'PayMux: openSession() requires a wallet. Pass wallet.privateKey to PayMux.create().'
      );
    }

    // Charge the full session budget against global spending limits upfront.
    // This ensures the agent can't circumvent daily limits by opening many sessions.
    // When the session closes, unspent budget is released back.
    // skipPerRequest: true — session budgets are envelopes containing many small
    // requests, not a single payment. A $5 session with perRequest=$2 is valid
    // because individual requests within the session will each be under $2.
    this.spendingEnforcer.check(config.budget, /* skipPerRequest */ true);

    const session = new PayMuxSession(
      this,
      { ...config, debug: config.debug ?? this.config.debug },
      this.spendingEnforcer
    );

    // M8 fix: Clean up closed/expired sessions on each openSession call
    // to prevent unbounded growth of the activeSessions array
    this.activeSessions = this.activeSessions.filter(s => s.isOpen);
    this.activeSessions.push(session);

    this.logger.info(
      `[paymux] [session] Opened session for ${config.url} — budget: $${config.budget.toFixed(2)}`,
      { event: 'session_opened', url: config.url, budget: config.budget, duration: config.duration }
    );

    return session;
  }

  /**
   * Get all active (not closed or expired) sessions.
   */
  get sessions(): readonly PayMuxSession[] {
    // Clean up closed/expired sessions
    this.activeSessions = this.activeSessions.filter(s => s.isOpen);
    return [...this.activeSessions];
  }

  // ── Protocol cache methods ──────────────────────────────────────────

  /**
   * MPP fast path — known-MPP URL with spending limits enforced BEFORE payment.
   *
   * When the protocol cache tells us a URL speaks MPP, we skip the full
   * PayMux protocol detection (which parses x402 headers, body, etc.) and
   * go directly to an MPP-specific probe to extract the payment amount.
   *
   * Flow (3 HTTP calls):
   *   1. MPP probe — plain fetch to get the 402 + WWW-Authenticate amount
   *   2. Spending limit check (perRequest, perDay, maxAmount) — BEFORE payment
   *   3. mppx.fetch() — handles its own probe + paid retry (2 HTTP calls)
   *
   * This is the same number of HTTP calls as the normal first-request path,
   * but skips the heavier protocol detection logic. The key guarantee:
   * **spending limits are ALWAYS enforced before money leaves the wallet.**
   *
   * If the endpoint no longer returns 402, we evict the cache entry and
   * return the non-402 response directly (no payment, no spending impact).
   */
  private async mppFastPath(
    url: string,
    init: RequestInit,
    maxAmount?: number,
    skipSpendingCheck?: boolean
  ): Promise<Response> {
    if (!this.mppClient) {
      throw new Error(
        'PayMux: MPP payment required but no wallet configured. ' +
          'Pass wallet.privateKey to PayMux.create().'
      );
    }

    // Step 1: Probe to extract amount BEFORE paying
    const probeResult = await probeMppAmount(url, init, this.probeTimeoutMs);

    // If probe returned non-402, endpoint no longer requires payment
    if (!probeResult) {
      this.logger.debug(`[paymux] [<] MPP fast path — endpoint no longer requires payment`, {
        event: 'mpp_no_longer_paid', url,
      });
      // Evict stale cache entry
      this.protocolCache.delete(this.getCacheKey(url));
      // Re-fetch to return the actual non-402 response to the caller.
      // (The probe consumed the response, so we need a fresh one.)
      // M7 fix: Only re-fetch for safe (idempotent) methods to avoid
      // double-submitting POSTs/PUTs/DELETEs.
      const method = (init.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        this.logger.warn(
          `[paymux] [warn] Non-idempotent ${method} to cached MPP URL returned non-402. ` +
          `The probe consumed the response. Returning a synthetic 200 to avoid double-submission.`,
          { event: 'mpp_non_idempotent_no_payment', method, url }
        );
        return new Response(null, { status: 200 });
      }
      return globalThis.fetch(url, init);
    }

    const amountUsd = probeResult.amountUsd;

    const currencyDisplay = getTokenName(probeResult.currency);
    this.logger.debug(
      `[paymux] [probe] MPP fast path: $${amountUsd.toFixed(6)} (raw: ${probeResult.amountRaw} ${currencyDisplay})`,
      { event: 'mpp_probe', amountUsd, amountRaw: probeResult.amountRaw, currency: probeResult.currency, url }
    );

    // Step 2: ENFORCE SPENDING LIMITS — all checks BEFORE payment
    // skipSpendingCheck: used by sessions whose budget was already reserved globally
    const shouldCheckSpendingFP = !skipSpendingCheck;

    // maxAmount ceiling check (USD) — always enforced regardless of skipSpendingCheck
    if (maxAmount !== undefined && amountUsd > maxAmount) {
      throw new Error(
        `PayMux: Payment of $${amountUsd.toFixed(6)} exceeds maxAmount of $${maxAmount.toFixed(2)}`
      );
    }

    // Per-request + per-day limits in USD (reserves amount as pending)
    let reservationFP: SpendingReservation | null = null;
    if (shouldCheckSpendingFP) {
      reservationFP = this.spendingEnforcer.check(amountUsd);
    }

    // Step 3: Pay via mppx — release pending on failure
    let response: Response;
    let result: PaymentResult;

    try {
      // Pass a minimal requirement so mppClient.pay() can populate the result
      // with the correct amount/currency (H5 fix: without this, amount would be "0")
      const payResult = await this.mppClient.pay(url, init, {
        protocol: 'mpp',
        amount: probeResult.amountRaw,
        currency: probeResult.currency,
        amountUsd,
      });
      response = payResult.response;
      result = payResult.result;
    } catch (error) {
      // On MppTimeoutError, do NOT release the pending reservation.
      // The mppx.fetch() may still complete in the background, and releasing
      // would make the spending invisible. The pending amount stays reserved
      // until the daily reset as a conservative safeguard.
      if (error instanceof MppTimeoutError) {
        this.logger.warn(
          `[paymux] [warn] MPP payment timed out — pending reservation of $${amountUsd.toFixed(6)} preserved as safeguard`,
          { event: 'mpp_timeout_pending_preserved', amountUsd, url }
        );
        throw error;
      }
      // Release the pending reservation so failed payments don't
      // permanently reduce daily spending capacity
      if (reservationFP) {
        this.spendingEnforcer.release(reservationFP);
      }
      // M2: Evict protocol cache on payment failure so next request
      // does a fresh protocol detection (handles transient issues)
      this.protocolCache.delete(this.getCacheKey(url));
      throw error;
    }

    // If mppx got a non-402 (server changed between our probe and mppx's probe),
    // release the pending amount since no payment was made
    if (!result.receipt) {
      if (reservationFP) {
        this.spendingEnforcer.release(reservationFP);
      }
      this.logger.debug(`[paymux] [<] ${response.status} (MPP fast path — no payment on retry)`, {
        event: 'mpp_no_payment_retry', status: response.status, url,
      });
      this.protocolCache.delete(this.getCacheKey(url));
      return response;
    }

    // Step 4: Record successful payment (moves from pending to confirmed)
    // Use the reservation token so the exact reserved amount is released from
    // pending. The actual amount (amountUsd) is recorded as confirmed spending.
    if (reservationFP) {
      this.spendingEnforcer.record(reservationFP, amountUsd);
    }

    // CRITICAL: Set amountUsd on the PaymentResult so downstream consumers
    // (e.g., session spending tracking) use the converted USD amount, not raw
    // base units. Without this, parseFloat("10000") would be $10,000 not $0.01.
    result.amountUsd = amountUsd;
    this._lastPaymentResult = result;
    this.recordPayment(result);

    this.logger.info(
      `[paymux] [ok] Paid $${amountUsd.toFixed(6)} via mpp (fast path)${result.transactionHash ? ` | tx: ${result.transactionHash}` : ''}`,
      { event: 'payment_success', protocol: 'mpp', amountUsd, transactionHash: result.transactionHash, fastPath: true, url }
    );

    return response;
  }

  /**
   * Get the cache key for a URL (origin + pathname, no query params).
   *
   * Stripping query params means that `api.example.com/data?page=1` and
   * `api.example.com/data?page=2` share the same cache entry, which is
   * correct since payment protocol is determined by the endpoint, not
   * query parameters.
   */
  private getCacheKey(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      // If URL parsing fails, use the raw string as the key
      return url;
    }
  }

  /**
   * Look up a cached protocol for a URL. Returns the protocol if cached
   * and not expired, or null if not found / expired.
   */
  private getCachedProtocol(url: string): Protocol | null {
    const key = this.getCacheKey(url);
    const entry = this.protocolCache.get(key);

    if (!entry) return null;

    // Check TTL — evict expired entries
    if (Date.now() - entry.cachedAt > PayMuxClient.PROTOCOL_CACHE_TTL_MS) {
      this.protocolCache.delete(key);
      return null;
    }

    return entry.protocol;
  }

  /**
   * Cache a detected protocol for a URL.
   *
   * Enforces a max cache size to prevent unbounded memory growth in
   * long-running agent processes that hit many different endpoints.
   */
  private setCachedProtocol(url: string, protocol: Protocol): void {
    const key = this.getCacheKey(url);

    // Evict oldest entries if cache is full
    if (
      this.protocolCache.size >= PayMuxClient.MAX_CACHE_ENTRIES &&
      !this.protocolCache.has(key)
    ) {
      // Map iteration order is insertion order — delete the first (oldest) entry
      const oldestKey = this.protocolCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.protocolCache.delete(oldestKey);
      }
    }

    this.protocolCache.set(key, {
      protocol,
      cachedAt: Date.now(),
    });
  }

  /**
   * Clear the protocol cache. Useful for testing or when you know
   * server configurations have changed.
   */
  clearProtocolCache(): void {
    this.protocolCache.clear();
  }

  // ── Timeout + Retry helpers ────────────────────────────────────

  /**
   * Fetch with probe timeout — wraps a single fetch call with an
   * AbortController-based timeout using `this.probeTimeoutMs`.
   *
   * Prevents the agent from blocking indefinitely if the server hangs
   * during the initial protocol-detection probe.
   */
  private async fetchWithProbeTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.probeTimeoutMs);

    try {
      return await globalThis.fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(
          `PayMux: Probe timed out after ${this.probeTimeoutMs}ms. The server may be unreachable. URL: ${url}`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Probe with retry — wraps the initial probe fetch with retry logic
   * for transient network failures.
   *
   * CRITICAL: Only retries safe HTTP methods (GET/HEAD by default).
   * POST/PUT/DELETE are never retried by default to prevent double-charges.
   * This ONLY wraps the initial probe — never retries after a payment.
   *
   * Retries on:
   * - Network errors (TypeError from fetch — DNS failure, connection refused, etc.)
   * - HTTP responses with status in retryableStatusCodes (default: 502, 503, 504)
   *
   * Uses exponential backoff: baseDelay * 2^attempt (1s, 2s, 4s...)
   */
  private async probeWithRetry(url: string, init: RequestInit): Promise<Response> {
    const rc = this.retryConfig;
    const method = (init.method ?? 'GET').toUpperCase();

    // No retry config, or method not retryable — single attempt
    if (!rc || !rc.retryMethods.includes(method)) {
      return this.fetchWithProbeTimeout(url, init);
    }

    const totalAttempts = 1 + rc.maxRetries; // 1 initial + N retries
    let lastError: unknown;
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        const response = await this.fetchWithProbeTimeout(url, init);

        // If response status is not retryable, return immediately
        if (!rc.retryableStatusCodes.includes(response.status)) {
          return response;
        }

        // Retryable status code — save response and maybe retry
        lastResponse = response;

        if (attempt < totalAttempts - 1) {
          const delayMs = rc.baseDelayMs * Math.pow(2, attempt);
          this.logger.debug(
            `[paymux] Retry ${attempt + 1}/${rc.maxRetries} after ${delayMs}ms (${response.status} ${response.statusText})`,
            { event: 'retry', attempt: attempt + 1, maxRetries: rc.maxRetries, delayMs, status: response.status, url }
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      } catch (error) {
        // Network errors (TypeError from fetch: DNS failure, connection refused, etc.)
        lastError = error;

        if (attempt < totalAttempts - 1) {
          const delayMs = rc.baseDelayMs * Math.pow(2, attempt);
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.debug(
            `[paymux] Retry ${attempt + 1}/${rc.maxRetries} after ${delayMs}ms (${errorMessage})`,
            { event: 'retry', attempt: attempt + 1, maxRetries: rc.maxRetries, delayMs, error: errorMessage, url }
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    // All retries exhausted — throw with context
    if (lastResponse) {
      throw new Error(
        `PayMux: Request failed after ${totalAttempts} attempts (1 initial + ${rc.maxRetries} retries). Last error: ${lastResponse.status} ${lastResponse.statusText}`
      );
    }

    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `PayMux: Request failed after ${totalAttempts} attempts (1 initial + ${rc.maxRetries} retries). Last error: ${errorMessage}`
    );
  }
}
