import type { PaymentRequirement, PaymentResult, WalletConfig, MppReceipt } from '../../shared/types.js';
import { base64urlDecode } from '../utils.js';

/**
 * MPP payment client — wraps mppx for session-based streaming payments.
 *
 * Uses mppx/client with polyfill: false to get a SCOPED fetch function.
 * This avoids patching globalThis.fetch (which would bypass spending controls
 * and affect all HTTP calls in the process).
 *
 * The scoped mppx.fetch() handles the full 402 → challenge → pay → retry flow.
 */
export class MppClient {
  private mppxFetch: typeof fetch | null = null;
  private initialized = false;
  /** Timeout in ms for mppx payment calls (default: 30s) */
  private paymentTimeoutMs: number;

  constructor(private walletConfig: WalletConfig, paymentTimeoutMs?: number) {
    this.paymentTimeoutMs = paymentTimeoutMs ?? 30_000;
  }

  /**
   * Lazily initialize mppx client with polyfill: false (scoped fetch, no global patching).
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const { Mppx, tempo } = await import('mppx/client');
      const { privateKeyToAccount } = await import('viem/accounts');

      if (!this.walletConfig.privateKey) {
        throw new Error(
          'PayMux MPP: wallet.privateKey is required for MPP payments'
        );
      }

      const account = privateKeyToAccount(this.walletConfig.privateKey);

      // CRITICAL: polyfill: false — do NOT patch globalThis.fetch
      // This gives us a scoped mppx.fetch() that only handles MPP challenges
      // without affecting the rest of the application or bypassing spending controls
      const mppx = Mppx.create({
        methods: [tempo({ account })],
        polyfill: false,
      });

      this.mppxFetch = mppx.fetch;
      this.initialized = true;
    } catch (error) {
      throw new Error(
        `PayMux MPP: Failed to initialize. Ensure mppx and viem are installed. ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Execute a paid request via MPP protocol.
   *
   * Uses mppx's scoped fetch which handles the full 402 → challenge → sign → retry
   * flow automatically. Single pass, no double-fetch.
   */
  async pay(
    url: string,
    init?: RequestInit,
    requirement?: PaymentRequirement
  ): Promise<{ response: Response; result: PaymentResult }> {
    await this.initialize();

    if (!this.mppxFetch) {
      throw new Error('PayMux MPP: client not initialized');
    }

    // mppx.fetch handles the full 402 challenge/response loop:
    //   1. Sends GET to URL
    //   2. If non-402, returns response immediately
    //   3. If 402, parses WWW-Authenticate: Payment challenge
    //   4. Signs payment on Tempo chain
    //   5. Retries with Authorization: Payment <credential>
    //   6. Returns the paid response with Payment-Receipt header
    //
    // Timeout: mppx.fetch is a wrapped fetch that may not support AbortSignal,
    // so we use Promise.race to enforce a hard timeout. If the Tempo chain or
    // the mppx server hangs, the agent won't block indefinitely.
    //
    // IMPORTANT: On timeout, mppx.fetch continues in the background. The payment
    // may still succeed. The caller (PayMuxClient) should NOT release the spending
    // reservation on MppTimeoutError — the pending amount stays reserved until the
    // daily reset as a conservative safeguard against untracked spending.
    const timeoutMs = this.paymentTimeoutMs;
    const response = await Promise.race([
      this.mppxFetch(url, init),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new MppTimeoutError(
            `PayMux: MPP payment timed out after ${timeoutMs}ms. The Tempo chain may be unreachable. ` +
            `Note: The payment may still complete in the background. The pending spending reservation ` +
            `is preserved as a safeguard.`
          )),
          timeoutMs,
        )
      ),
    ]);

    if (response.status === 402) {
      throw new Error(
        `PayMux MPP: Payment failed — server returned 402 after payment attempt. URL: ${url}`
      );
    }

    // Parse Payment-Receipt header (base64url-encoded JSON)
    const receiptHeader = response.headers.get('payment-receipt');
    let receipt: MppReceipt | undefined;
    let transactionHash: string | undefined;

    if (receiptHeader) {
      try {
        // Payment-Receipt is base64url-encoded JSON per the MPP spec
        // Fields: { status: "success", method, reference, timestamp, externalId? }
        const decoded = base64urlDecode(receiptHeader);
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
          // MPP spec: 'reference' contains the tx hash or payment intent ID
          transactionHash = receipt.reference;
        }
      } catch {
        // Receipt parsing failed — non-critical, payment still succeeded
      }
    }

    const result: PaymentResult = {
      protocol: 'mpp',
      amount: requirement?.amount ?? '0',
      currency: requirement?.currency ?? 'USD',
      transactionHash,
      receipt,
      settledAt: Date.now(),
    };

    return { response, result };
  }

  canHandle(requirement: PaymentRequirement): boolean {
    if (requirement.protocol !== 'mpp') return false;
    if (!this.walletConfig.privateKey) return false;
    return true;
  }
}

/**
 * Error thrown when an MPP payment times out.
 *
 * Unlike a regular timeout error, this signals that the underlying mppx.fetch()
 * may still complete in the background (payment may have been sent). Callers
 * should NOT release the spending reservation when catching this error — the
 * pending amount is preserved as a conservative safeguard.
 */
export class MppTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MppTimeoutError';
  }
}
