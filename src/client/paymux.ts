import type { PayMuxConfig, PayMuxFetchOptions } from './types.js';
import type { PaymentResult } from '../shared/types.js';
import { detectProtocol } from './protocols/detector.js';
import { X402Client } from './protocols/x402.js';
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
 * v0.1.0 supports x402 protocol. MPP support ships in v0.2.0.
 *
 * Architecture: In v0.1.0 (x402-only), we delegate the entire fetch to
 * @x402/fetch's wrapFetchWithPayment. It handles 402 detection, payment
 * signing, and retry internally — no separate probe request needed.
 * Result: 1 HTTP call for non-402, 2 HTTP calls for 402. Zero overhead.
 */
export class PayMuxClient {
  private x402Client: X402Client | null = null;
  private spendingEnforcer: SpendingEnforcer;
  private config: PayMuxConfig;
  private paymentHistory: PaymentResult[] = [];
  private static readonly MAX_HISTORY = 10000;

  constructor(config: PayMuxConfig) {
    this.config = config;
    this.spendingEnforcer = new SpendingEnforcer(config.limits ?? {});

    if (config.wallet?.privateKey) {
      this.x402Client = new X402Client(config.wallet);
    } else if (config.wallet?.privy || config.wallet?.coinbase) {
      console.warn(
        '[paymux] Warning: wallet.privy and wallet.coinbase are not yet supported. ' +
          'Only wallet.privateKey is currently implemented. ' +
          'No payment clients were initialized.'
      );
    }
  }

  /**
   * Fetch a resource, automatically handling payment if required.
   *
   * For x402 endpoints: @x402/fetch handles the full 402 -> sign -> retry
   * flow in a single pass (no probe request, no double-fetch).
   *
   * For non-402 responses: Returns immediately with zero payment overhead.
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
    const { maxAmount, skipPayment, ...fetchInit } = options;

    if (skipPayment) {
      return globalThis.fetch(urlString, fetchInit);
    }

    this.log(`[paymux] [>] ${fetchInit.method ?? 'GET'} ${urlString}`);

    // x402 path: single-pass via @x402/fetch (no probe, no double-fetch)
    if (this.x402Client) {
      // Pre-flight: check daily limit has remaining capacity
      const stats = this.spendingEnforcer.stats();
      if (stats.dailyRemaining !== undefined && stats.dailyRemaining <= 0) {
        throw new Error(
          `PayMux: Daily spending limit of $${stats.dailyLimit?.toFixed(2)} reached ` +
            `(spent: $${stats.dailySpend.toFixed(2)})`
        );
      }

      // Single call — @x402/fetch handles:
      //   non-402 → returns response directly (1 HTTP call)
      //   402 → detects protocol, signs payment, retries (2 HTTP calls)
      const { response, result } = await this.x402Client.pay(urlString, fetchInit);

      const paidAmount = parseFloat(result.amount);

      if (paidAmount > 0) {
        // Post-payment limit checks (amount is known only after server responds)
        if (maxAmount !== undefined && paidAmount > maxAmount) {
          this.log(
            `[paymux] [warn] Paid $${paidAmount.toFixed(2)} (exceeded maxAmount $${maxAmount.toFixed(2)}, already settled)`
          );
        }

        // Record payment for spending tracking
        this.spendingEnforcer.record(paidAmount);
        this.paymentHistory.push(result);

        if (this.paymentHistory.length > PayMuxClient.MAX_HISTORY) {
          this.paymentHistory = this.paymentHistory.slice(-PayMuxClient.MAX_HISTORY);
        }

        this.log(
          `[paymux] [ok] Paid ${result.amount} ${result.currency} via ${result.protocol}${result.transactionHash ? ` | tx: ${result.transactionHash}` : ''}`
        );
      } else {
        this.log(`[paymux] [<] ${response.status} (no payment required)`);
      }

      return response;
    }

    // No payment client — plain fetch
    const response = await globalThis.fetch(urlString, fetchInit);

    if (response.status === 402) {
      const requirements = await detectProtocol(response);
      if (requirements.length > 0) {
        throw new Error(
          `PayMux: Server requires ${requirements[0].protocol} payment but no wallet is configured. ` +
            'Pass wallet.privateKey to PayMux.create().'
        );
      }
      throw new Error(
        'PayMux: Server returned 402 Payment Required but no wallet is configured. ' +
          'Pass wallet.privateKey to PayMux.create().'
      );
    }

    this.log(`[paymux] [<] ${response.status}`);
    return response;
  }

  /**
   * Get spending statistics
   */
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
