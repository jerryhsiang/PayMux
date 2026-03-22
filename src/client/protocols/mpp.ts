import type { PaymentRequirement, PaymentResult, WalletConfig } from '../../shared/types.js';

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

  constructor(private walletConfig: WalletConfig) {}

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
    const response = await this.mppxFetch(url, init);

    if (response.status === 402) {
      throw new Error(
        `PayMux MPP: Payment failed — server returned 402 after payment attempt. URL: ${url}`
      );
    }

    // Parse Payment-Receipt header (base64url-encoded JSON)
    const receiptHeader = response.headers.get('payment-receipt');
    let receipt: unknown = null;
    let transactionHash: string | undefined;

    if (receiptHeader) {
      try {
        // Payment-Receipt is base64url-encoded JSON per the MPP spec
        // Fields: { status: "success", method, reference, timestamp, externalId? }
        const decoded = atob(receiptHeader.replace(/-/g, '+').replace(/_/g, '/'));
        receipt = JSON.parse(decoded);
        if (receipt && typeof receipt === 'object') {
          // MPP spec: 'reference' contains the tx hash or payment intent ID
          transactionHash = (receipt as Record<string, unknown>).reference as string;
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
