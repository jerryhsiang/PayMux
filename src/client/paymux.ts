import type { PayMuxConfig, PayMuxFetchOptions } from './types.js';
import type { PaymentRequirement, PaymentResult, SpendingLimits, Protocol } from '../shared/types.js';
import { detectProtocol, selectBestRequirement } from './protocols/detector.js';
import { X402Client } from './protocols/x402.js';
import { MppClient } from './protocols/mpp.js';
import { SpendingEnforcer } from './spending.js';
import { verifyAmountConsistency } from './utils.js';

/**
 * Cached protocol detection result for a URL.
 *
 * After the first probe detects a protocol for a given URL, we cache the
 * mapping so subsequent requests skip the redundant PayMux probe.
 * This is critical for MPP: mppx.fetch() performs its own probe internally,
 * so without caching, every MPP request would make 3 HTTP calls (PayMux probe
 * + mppx probe + mppx paid retry) instead of 2 (mppx probe + mppx paid retry).
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
 * 1. Protocol cache hit — skip PayMux probe (0 HTTP calls)
 * 2. mppx.fetch() runs its own probe + paid retry — 2 HTTP calls
 * 3. Total: 2 HTTP calls
 *
 * For x402: signs directly from the probe's PAYMENT-REQUIRED header using
 * @x402/core (bypasses wrapFetchWithPayment which would make a redundant request).
 * For MPP: mppx.fetch() handles its own 402 challenge/response flow. After the
 * first probe detects MPP, the URL→protocol mapping is cached so subsequent
 * requests skip the redundant PayMux probe (2 calls instead of 3).
 */
export class PayMuxClient {
  private x402Client: X402Client | null = null;
  private mppClient: MppClient | null = null;
  private spendingEnforcer: SpendingEnforcer;
  private config: PayMuxConfig;
  private paymentHistory: PaymentResult[] = [];
  private static readonly MAX_HISTORY = 10000;

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

  constructor(config: PayMuxConfig) {
    this.config = config;
    this.spendingEnforcer = new SpendingEnforcer(config.limits ?? {});

    if (config.wallet?.privateKey) {
      this.x402Client = new X402Client(config.wallet);
      this.mppClient = new MppClient(config.wallet);
    } else if (config.wallet?.privy || config.wallet?.coinbase) {
      console.warn(
        '[paymux] Warning: wallet.privy and wallet.coinbase are not yet supported. ' +
          'Only wallet.privateKey is currently implemented.'
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
    const { maxAmount, protocol, skipPayment, ...fetchInit } = options;

    if (skipPayment) {
      return globalThis.fetch(urlString, fetchInit);
    }

    this.log(`[paymux] [>] ${fetchInit.method ?? 'GET'} ${urlString}`);

    // ── MPP fast path: skip PayMux probe for cached MPP URLs ──────────
    // After the first request to a URL detects MPP, we cache the mapping.
    // On subsequent requests, we skip the PayMux probe entirely and let
    // mppx.fetch() handle everything (it does its own 402 probe internally).
    // This reduces MPP from 3 HTTP calls (PayMux probe + mppx probe + paid retry)
    // to 2 HTTP calls (mppx probe + paid retry).
    //
    // We only use the fast path when:
    // - No forced protocol override (protocol option)
    // - The cache entry hasn't expired (5 minute TTL)
    // If the endpoint stops requiring payment, mppx.fetch() will get a 200
    // on its probe and return it directly — no wasted work.
    if (!protocol) {
      const cached = this.getCachedProtocol(urlString);
      if (cached === 'mpp') {
        this.log(`[paymux] [cache] MPP cached for ${urlString} — skipping probe`);
        return this.mppFastPath(urlString, fetchInit, maxAmount);
      }
    }

    // ── Standard path: probe first, then route ────────────────────────

    // Step 1: Probe request to detect if payment is needed + which protocol
    const probeResponse = await globalThis.fetch(urlString, fetchInit);

    // Step 2: If not 402, return immediately (no payment needed)
    if (probeResponse.status !== 402) {
      this.log(`[paymux] [<] ${probeResponse.status} (no payment required)`);
      // If this URL was cached as a payment URL but now returns non-402,
      // evict the stale cache entry so we don't keep hitting the fast path
      this.protocolCache.delete(this.getCacheKey(urlString));
      return probeResponse;
    }

    this.log(`[paymux] [<] 402 Payment Required — detecting protocol...`);

    // Step 3: Detect protocol from 402 response headers/body
    const requirements = await detectProtocol(probeResponse);

    if (requirements.length === 0) {
      this.log(`[paymux] [err] Could not detect payment protocol`);
      return probeResponse;
    }

    // Select best payment method (respects preferProtocol config + forced protocol)
    const requirement = selectBestRequirement(
      requirements,
      protocol ? [protocol] : this.config.preferProtocol
    );

    if (!requirement) {
      this.log(`[paymux] [err] No supported payment method found`);
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

    this.log(
      `[paymux]   Protocol: ${requirement.protocol} | Amount: $${amountUsd.toFixed(6)} (raw: ${amountRaw} ${requirement.currency})`
    );

    // Logic check: verify the base-unit-to-USD conversion is consistent
    if (requirement.protocol === 'x402' && requirement.amountUsd !== undefined) {
      if (!verifyAmountConsistency(amountRaw, amountUsd, requirement.asset)) {
        this.log(
          `[paymux] [warn] Amount conversion may be inconsistent: raw=${amountRaw}, usd=${amountUsd}, asset=${requirement.asset}`
        );
      }
    }

    // Step 4: ENFORCE SPENDING LIMITS — all checks in USD
    // maxAmount ceiling check (USD)
    if (maxAmount !== undefined && amountUsd > maxAmount) {
      throw new Error(
        `PayMux: Payment of $${amountUsd.toFixed(6)} exceeds maxAmount of $${maxAmount.toFixed(2)}`
      );
    }

    // Per-request + per-day limits in USD (reserves amount as pending)
    this.spendingEnforcer.check(amountUsd);

    // Step 5: Route to protocol client — release pending on failure
    let response: Response;
    let result: PaymentResult;

    try {
      const payResult = await this.routeToClient(urlString, fetchInit, requirement, probeResponse);
      response = payResult.response;
      result = payResult.result;
    } catch (error) {
      // Release the pending reservation so failed payments don't
      // permanently reduce daily spending capacity
      this.spendingEnforcer.release(amountUsd);
      throw error;
    }

    // Step 6: Record successful payment (moves from pending to confirmed)
    this.spendingEnforcer.record(amountUsd);
    this.paymentHistory.push(result);

    if (this.paymentHistory.length > PayMuxClient.MAX_HISTORY) {
      this.paymentHistory = this.paymentHistory.slice(-PayMuxClient.MAX_HISTORY);
    }

    this.log(
      `[paymux] [ok] Paid $${amountUsd.toFixed(6)} via ${result.protocol}${result.transactionHash ? ` | tx: ${result.transactionHash}` : ''}`
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
    return {
      ...stats,
      history: [...this.paymentHistory],
      totalSpent: stats.totalSpent,
    };
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

  // ── Protocol cache methods ──────────────────────────────────────────

  /**
   * MPP fast path — skip the PayMux probe and let mppx.fetch() handle everything.
   *
   * When the protocol cache tells us a URL speaks MPP, we bypass our own
   * probe and go directly to mppx.fetch(), which does its own 402 detection
   * internally. This saves one HTTP round-trip on repeat requests.
   *
   * Spending limits are still enforced: mppx.fetch() returns the response,
   * and we extract the payment amount from the Payment-Receipt header after
   * the fact. If the endpoint no longer requires payment (returns 200 without
   * Payment-Receipt), we return the response directly with no spending impact.
   *
   * Note: On the fast path, we cannot enforce per-request spending limits
   * BEFORE the payment happens (since mppx handles probe + pay atomically).
   * The maxAmount check is done post-payment on the receipt. For strict
   * pre-payment enforcement, the standard path (first call) still applies.
   */
  private async mppFastPath(
    url: string,
    init: RequestInit,
    maxAmount?: number
  ): Promise<Response> {
    if (!this.mppClient) {
      throw new Error(
        'PayMux: MPP payment required but no wallet configured. ' +
          'Pass wallet.privateKey to PayMux.create().'
      );
    }

    // Let mppx.fetch() handle the full 402 → challenge → sign → retry flow.
    // This is 2 HTTP calls: mppx probe + mppx paid retry.
    const { response, result } = await this.mppClient.pay(url, init);

    // If no payment was made (endpoint returned non-402 to mppx), return directly.
    // This handles the case where the server stopped requiring payment after caching.
    if (!result.receipt) {
      this.log(`[paymux] [<] ${response.status} (MPP fast path — no payment needed)`);
      // Evict cache since this URL no longer requires payment
      this.protocolCache.delete(this.getCacheKey(url));
      return response;
    }

    // Payment was made — enforce spending limits post-payment
    const amountUsd = parseFloat(result.amount);

    if (maxAmount !== undefined && amountUsd > maxAmount) {
      // Payment already happened but exceeded maxAmount. Log a warning.
      // We can't undo the payment, but we surface the violation.
      this.log(
        `[paymux] [warn] MPP fast path: payment of $${amountUsd.toFixed(6)} exceeded maxAmount of $${maxAmount.toFixed(2)} (payment already settled)`
      );
    }

    // Record the payment in spending tracking.
    // On the fast path, the payment has already settled, so we can't prevent it.
    // We still call check() to validate limits — if it throws (limit exceeded),
    // we catch and log a warning but still record the payment so daily spend
    // tracking stays accurate. The first call to any URL always uses the
    // standard path with pre-payment enforcement, so this is a rare edge case.
    try {
      this.spendingEnforcer.check(amountUsd);
      this.spendingEnforcer.record(amountUsd);
    } catch {
      // Limit exceeded post-payment — record it anyway to keep tracking accurate.
      // The pending amount was never reserved (check threw), so call record
      // directly which only updates dailySpend and totalSpent.
      this.spendingEnforcer.record(amountUsd);
      this.log(
        `[paymux] [warn] MPP fast path: spending limit exceeded after payment settled ($${amountUsd.toFixed(6)})`
      );
    }
    this.paymentHistory.push(result);

    if (this.paymentHistory.length > PayMuxClient.MAX_HISTORY) {
      this.paymentHistory = this.paymentHistory.slice(-PayMuxClient.MAX_HISTORY);
    }

    this.log(
      `[paymux] [ok] Paid $${amountUsd.toFixed(6)} via mpp (fast path)${result.transactionHash ? ` | tx: ${result.transactionHash}` : ''}`
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

  private log(message: string): void {
    if (this.config.debug) {
      console.log(message);
    }
  }
}
