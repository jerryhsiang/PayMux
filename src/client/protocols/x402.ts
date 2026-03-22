import type { PaymentRequirement, PaymentResult, WalletConfig, X402Receipt } from '../../shared/types.js';

/**
 * x402 payment client — uses @x402/core directly for payment signing.
 *
 * Architecture (2 HTTP calls, not 3):
 * 1. PayMux probe request already got the 402 + PAYMENT-REQUIRED header
 * 2. This client signs the payment locally (no HTTP call — pure crypto)
 * 3. This client makes ONE retry with the PAYMENT-SIGNATURE header
 *
 * Previously used wrapFetchWithPayment which made its OWN probe request,
 * resulting in 3 HTTP calls. Now we bypass it and use @x402/core directly.
 */
export class X402Client {
  private coreClient: unknown = null;
  private httpClient: unknown = null;
  private initialized = false;
  /** Timeout in ms for x402 payment calls (default: 30s) */
  private paymentTimeoutMs: number;

  constructor(private walletConfig: WalletConfig, paymentTimeoutMs?: number) {
    this.paymentTimeoutMs = paymentTimeoutMs ?? 30_000;
  }

  /**
   * Lazily initialize the x402 signing client.
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const { x402Client, x402HTTPClient } = await import('@x402/core/client');
      const { registerExactEvmScheme } = await import('@x402/evm/exact/client');
      const { privateKeyToAccount } = await import('viem/accounts');

      if (!this.walletConfig.privateKey) {
        throw new Error(
          'PayMux x402: wallet.privateKey is required for x402 payments'
        );
      }

      const signer = privateKeyToAccount(this.walletConfig.privateKey);
      const client = new x402Client();
      registerExactEvmScheme(client, { signer });

      this.coreClient = client;
      this.httpClient = new x402HTTPClient(client);
      this.initialized = true;
    } catch (error) {
      throw new Error(
        `PayMux x402: Failed to initialize. Ensure @x402/core, @x402/evm, and viem are installed. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Sign a payment from the probe's 402 response and retry with payment proof.
   *
   * This makes exactly ONE HTTP request (the paid retry).
   * The probe request was already made by PayMux's detector.
   *
   * @param url - The URL to retry with payment
   * @param init - Fetch options for the retry request
   * @param requirement - Parsed payment requirement from the probe's 402 response
   * @param probeResponse - The original 402 response (for header extraction)
   */
  async pay(
    url: string,
    init?: RequestInit,
    requirement?: PaymentRequirement,
    probeResponse?: Response
  ): Promise<{ response: Response; result: PaymentResult }> {
    await this.initialize();

    const httpClient = this.httpClient as {
      getPaymentRequiredResponse: (getHeader: (name: string) => string | null | undefined) => unknown;
      encodePaymentSignatureHeader: (payload: unknown) => Record<string, string>;
    };
    const coreClient = this.coreClient as {
      createPaymentPayload: (paymentRequired: unknown) => Promise<unknown>;
    };

    // Step 1: Parse the PaymentRequired from the probe response headers
    if (!probeResponse) {
      throw new Error(
        'PayMux x402: probeResponse is required for direct signing. ' +
          'This is a PayMux internal error — the probe response should always be passed.'
      );
    }

    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name: string) => probeResponse.headers.get(name)
    );

    // Step 2: Create signed payment payload (pure local crypto, NO HTTP call)
    const paymentPayload = await coreClient.createPaymentPayload(paymentRequired);

    // Step 3: Encode into headers
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    // Step 4: Make ONE retry request with payment proof
    // Timeout: if the server hangs after receiving payment, the agent won't
    // block indefinitely. Uses Promise.race similar to MppClient.
    const existingHeaders = init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init?.headers as Record<string, string> | undefined) ?? {};

    const timeoutMs = this.paymentTimeoutMs;
    const response = await Promise.race([
      globalThis.fetch(url, {
        ...init,
        headers: {
          ...existingHeaders,
          ...paymentHeaders,
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(
            `PayMux: x402 payment timed out after ${timeoutMs}ms. The server may be unreachable. URL: ${url}`
          )),
          timeoutMs,
        )
      ),
    ]);

    // If we still get a 402, payment was rejected
    if (response.status === 402) {
      throw new Error(
        `PayMux x402: Payment rejected by server after signing. URL: ${url}`
      );
    }

    // Extract receipt from response headers
    const paymentResponseHeader = response.headers.get('payment-response');
    let receipt: X402Receipt | undefined;
    let transaction: string | undefined;

    if (paymentResponseHeader) {
      try {
        const parsed: unknown = JSON.parse(atob(paymentResponseHeader));
        if (parsed && typeof parsed === 'object') {
          const raw = parsed as Record<string, unknown>;
          receipt = {
            success: raw.success === true,
            transaction: raw.transaction as string | undefined,
            network: raw.network as string | undefined,
            payer: raw.payer as string | undefined,
          };
          transaction = receipt.transaction ?? (raw.transactionHash as string | undefined);
        }
      } catch {
        // Receipt parsing failed — non-critical
      }
    }

    const result: PaymentResult = {
      protocol: 'x402',
      amount: requirement?.amount ?? '0',
      currency: requirement?.currency ?? 'USDC',
      transactionHash: transaction,
      receipt,
      settledAt: Date.now(),
    };

    return { response, result };
  }

  /**
   * Check if this client can handle a given payment requirement
   */
  canHandle(requirement: PaymentRequirement): boolean {
    if (requirement.protocol !== 'x402') return false;
    if (!this.walletConfig.privateKey) return false;

    const network = requirement.network ?? '';
    if (network === '') return false;
    if (network.startsWith('eip155:')) return true;

    const evmChains = [
      'base', 'base-sepolia', 'polygon', 'polygon-amoy',
      'ethereum', 'ethereum-sepolia',
    ];
    return evmChains.includes(network);
  }
}
