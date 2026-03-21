import type { PaymentRequirement, PaymentResult, WalletConfig } from '../../shared/types.js';

/**
 * x402 payment client — wraps @x402/fetch to handle the full 402 → pay → retry flow.
 *
 * IMPORTANT: This client handles the ENTIRE flow (request → 402 → pay → retry → response).
 * The caller should NOT make an initial request first — that would double-fetch.
 * Instead, pass the URL directly to pay() and let @x402/fetch handle everything.
 */
export class X402Client {
  private fetchWithPayment: typeof fetch | null = null;
  private initialized = false;

  constructor(private walletConfig: WalletConfig) {}

  /**
   * Lazily initialize the x402 client.
   * This avoids importing heavy crypto libraries until needed.
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const { wrapFetchWithPayment } = await import('@x402/fetch');
      const { x402Client } = await import('@x402/core/client');
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

      this.fetchWithPayment = wrapFetchWithPayment(globalThis.fetch, client);
      this.initialized = true;
    } catch (error) {
      throw new Error(
        `PayMux x402: Failed to initialize. Ensure @x402/fetch, @x402/core, @x402/evm, and viem are installed. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Execute a paid request via x402 protocol.
   *
   * This is the ONLY fetch for this request — @x402/fetch's wrapFetchWithPayment
   * handles the full 402 → sign → pay → retry flow internally.
   * No double-fetch.
   */
  async pay(
    url: string,
    init?: RequestInit,
    requirement?: PaymentRequirement
  ): Promise<{ response: Response; result: PaymentResult }> {
    await this.initialize();

    if (!this.fetchWithPayment) {
      throw new Error('PayMux x402: client not initialized');
    }

    const response = await this.fetchWithPayment(url, init);

    // If we still get a 402, payment failed
    if (response.status === 402) {
      throw new Error(
        `PayMux x402: Payment failed — server returned 402 after payment attempt. URL: ${url}`
      );
    }

    // Extract payment receipt from response headers (x402 spec: success/transaction/network)
    const paymentResponseHeader = response.headers.get('payment-response');
    let receipt: unknown = null;
    let transaction: string | undefined;

    if (paymentResponseHeader) {
      try {
        receipt = JSON.parse(atob(paymentResponseHeader));
        if (receipt && typeof receipt === 'object') {
          // x402 spec uses 'transaction', but also handle 'transactionHash' for compat
          transaction =
            (receipt as Record<string, unknown>).transaction as string ??
            (receipt as Record<string, unknown>).transactionHash as string;
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
    // Reject empty network — we need to know which chain
    if (network === '') return false;

    // EVM chains via CAIP-2
    if (network.startsWith('eip155:')) return true;

    // Named EVM chains
    const evmChains = [
      'base', 'base-sepolia', 'polygon', 'polygon-amoy',
      'ethereum', 'ethereum-sepolia',
    ];
    return evmChains.includes(network);
  }
}
