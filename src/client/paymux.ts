import type { PayMuxConfig, PayMuxFetchOptions } from './types.js';
import type { PaymentRequirement, PaymentResult } from '../shared/types.js';
import { detectProtocol, selectBestRequirement } from './protocols/detector.js';
import { X402Client } from './protocols/x402.js';
import { MppClient } from './protocols/mpp.js';
import { SpendingEnforcer } from './spending.js';

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
 * Supports x402 and MPP protocols. Each protocol client uses a SCOPED fetch
 * (no globalThis.fetch patching) and handles the full 402 → pay → retry flow.
 *
 * Architecture:
 * - For known x402 endpoints: delegates to @x402/fetch (single-pass, 1-2 HTTP calls)
 * - For known MPP endpoints: delegates to mppx (single-pass, 1-2 HTTP calls)
 * - For unknown endpoints: probes first to detect protocol, then delegates
 */
export class PayMuxClient {
  private x402Client: X402Client | null = null;
  private mppClient: MppClient | null = null;
  private spendingEnforcer: SpendingEnforcer;
  private config: PayMuxConfig;
  private paymentHistory: PaymentResult[] = [];
  private static readonly MAX_HISTORY = 10000;

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
   * Multi-protocol routing:
   * 1. If user specifies a protocol, delegates directly to that client
   * 2. Otherwise, tries x402 first (via @x402/fetch, handles 402 internally)
   * 3. If x402 doesn't handle the 402, probes for MPP (WWW-Authenticate: Payment)
   * 4. Routes to the appropriate protocol client
   *
   * Both x402 and MPP clients use scoped fetch — no globalThis patching.
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

    // Pre-flight: check daily limit has remaining capacity
    const stats = this.spendingEnforcer.stats();
    if (stats.dailyRemaining !== undefined && stats.dailyRemaining <= 0) {
      throw new Error(
        `PayMux: Daily spending limit of $${stats.dailyLimit?.toFixed(2)} reached ` +
          `(spent: $${stats.dailySpend.toFixed(2)})`
      );
    }

    // If user specified a protocol, go directly to that client
    if (protocol === 'mpp' && this.mppClient) {
      return this.payViaClient(this.mppClient, urlString, fetchInit, maxAmount);
    }
    if (protocol === 'x402' && this.x402Client) {
      return this.payViaClient(this.x402Client, urlString, fetchInit, maxAmount);
    }

    // Multi-protocol auto-detection
    // Try x402 first (most common, @x402/fetch handles the flow)
    if (this.x402Client) {
      try {
        const { response, result } = await this.x402Client.pay(urlString, fetchInit);

        // If x402 handled it (paid or non-402), we're done
        if (result.amount !== '0' || response.status !== 402) {
          if (parseFloat(result.amount) > 0) {
            this.recordPayment(result, maxAmount);
          } else {
            this.log(`[paymux] [<] ${response.status} (no payment required)`);
          }
          return response;
        }
      } catch {
        // x402 couldn't handle it — fall through to MPP detection
      }
    }

    // x402 didn't handle it. Probe for MPP or other protocols.
    const probeResponse = await globalThis.fetch(urlString, fetchInit);

    if (probeResponse.status !== 402) {
      this.log(`[paymux] [<] ${probeResponse.status} (no payment required)`);
      return probeResponse;
    }

    // Detect protocol from 402 response
    const requirements = await detectProtocol(probeResponse);
    if (requirements.length === 0) {
      this.log(`[paymux] [err] Could not detect payment protocol from 402 response`);
      return probeResponse;
    }

    const requirement = selectBestRequirement(requirements);
    if (!requirement) {
      return probeResponse;
    }

    this.log(`[paymux]   Detected: ${requirement.protocol}`);

    // Route to MPP
    if (requirement.protocol === 'mpp' && this.mppClient) {
      return this.payViaClient(this.mppClient, urlString, fetchInit, maxAmount);
    }

    // No handler found
    if (!this.x402Client && !this.mppClient) {
      throw new Error(
        `PayMux: Server requires ${requirement.protocol} payment but no wallet is configured. ` +
          'Pass wallet.privateKey to PayMux.create().'
      );
    }

    this.log(`[paymux] [err] No client available for protocol: ${requirement.protocol}`);
    return probeResponse;
  }

  /**
   * Pay via a specific protocol client
   */
  private async payViaClient(
    client: X402Client | MppClient,
    url: string,
    init: RequestInit,
    maxAmount?: number
  ): Promise<Response> {
    const { response, result } = await client.pay(url, init);

    if (parseFloat(result.amount) > 0) {
      this.recordPayment(result, maxAmount);
    } else {
      this.log(`[paymux] [<] ${response.status} (no payment required)`);
    }

    return response;
  }

  /**
   * Record a successful payment in spending tracker
   */
  private recordPayment(result: PaymentResult, maxAmount?: number): void {
    const paidAmount = parseFloat(result.amount);

    if (maxAmount !== undefined && paidAmount > maxAmount) {
      this.log(
        `[paymux] [warn] Paid $${paidAmount.toFixed(2)} (exceeded maxAmount $${maxAmount.toFixed(2)}, already settled)`
      );
    }

    this.spendingEnforcer.record(paidAmount);
    this.paymentHistory.push(result);

    if (this.paymentHistory.length > PayMuxClient.MAX_HISTORY) {
      this.paymentHistory = this.paymentHistory.slice(-PayMuxClient.MAX_HISTORY);
    }

    this.log(
      `[paymux] [ok] Paid ${result.amount} ${result.currency} via ${result.protocol}${result.transactionHash ? ` | tx: ${result.transactionHash}` : ''}`
    );
  }

  get spending() {
    const stats = this.spendingEnforcer.stats();
    return {
      ...stats,
      history: [...this.paymentHistory],
      totalSpent: stats.totalSpent,
    };
  }

  private log(message: string): void {
    if (this.config.debug) {
      console.log(message);
    }
  }
}
