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
 * Architecture: Probe-first for protocol detection + spending enforcement.
 *
 * Flow:
 * 1. Send probe request (plain fetch)
 * 2. If non-402, return immediately (1 HTTP call, zero overhead)
 * 3. If 402, detect protocol + extract amount from response
 * 4. Enforce spending limits (per-request, per-day, maxAmount)
 * 5. Route to correct protocol client (x402 or MPP) — which makes its OWN
 *    full request (the probe is not reused, because protocol clients handle
 *    the entire 402 → pay → retry flow internally)
 * 6. Total: 3 HTTP calls for paid requests (probe + client's 402 + paid retry)
 *
 * The probe adds 1 extra request vs. direct protocol routing, but it's required
 * to enforce spending limits BEFORE payment (knowing the amount before signing).
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

    // Step 1: Probe request to detect if payment is needed + which protocol
    const probeResponse = await globalThis.fetch(urlString, fetchInit);

    // Step 2: If not 402, return immediately (no payment needed)
    if (probeResponse.status !== 402) {
      this.log(`[paymux] [<] ${probeResponse.status} (no payment required)`);
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

    const amount = parseFloat(requirement.amount);
    this.log(
      `[paymux]   Protocol: ${requirement.protocol} | Amount: ${amount} ${requirement.currency}`
    );

    // Step 4: ENFORCE SPENDING LIMITS — before any payment is made
    // maxAmount ceiling check
    if (maxAmount !== undefined && amount > maxAmount) {
      throw new Error(
        `PayMux: Payment of $${amount.toFixed(2)} exceeds maxAmount of $${maxAmount.toFixed(2)}`
      );
    }

    // Per-request + per-day limits (reserves amount as pending)
    this.spendingEnforcer.check(amount);

    // Step 5: Route to protocol client — release pending on failure
    let response: Response;
    let result: PaymentResult;

    try {
      const payResult = await this.routeToClient(urlString, fetchInit, requirement);
      response = payResult.response;
      result = payResult.result;
    } catch (error) {
      // Release the pending reservation so failed payments don't
      // permanently reduce daily spending capacity
      this.spendingEnforcer.release(amount);
      throw error;
    }

    // Step 6: Record successful payment (moves from pending to confirmed)
    this.spendingEnforcer.record(amount);
    this.paymentHistory.push(result);

    if (this.paymentHistory.length > PayMuxClient.MAX_HISTORY) {
      this.paymentHistory = this.paymentHistory.slice(-PayMuxClient.MAX_HISTORY);
    }

    this.log(
      `[paymux] [ok] Paid ${requirement.amount} ${requirement.currency} via ${result.protocol}${result.transactionHash ? ` | tx: ${result.transactionHash}` : ''}`
    );

    return response;
  }

  /**
   * Route to the correct protocol client based on detected requirement.
   */
  private async routeToClient(
    url: string,
    init: RequestInit,
    requirement: PaymentRequirement
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
        return this.x402Client.pay(url, init, requirement);
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
