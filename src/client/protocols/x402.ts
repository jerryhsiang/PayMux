import type { PaymentRequirement, PaymentResult, WalletConfig, X402Receipt } from '../../shared/types.js';

/**
 * Known EIP-712 domain parameters for USDC by CAIP-2 network ID.
 *
 * Used as fallback defaults when a third-party x402 server omits `extra.name`
 * and `extra.version` from its PaymentRequired response. Without these, @x402/evm's
 * `signEIP3009Authorization()` throws:
 *   "EIP-712 domain parameters (name, version) are required"
 *
 * Values sourced from the USDC token contracts on each chain.
 * The `name` is the token's ERC-20 name() and `version` is its EIP-712 domain version.
 */
const USDC_EIP712_DEFAULTS: Record<string, { name: string; version: string }> = {
  'eip155:8453':     { name: 'USD Coin', version: '2' },   // Base mainnet
  'eip155:84532':    { name: 'USDC',     version: '2' },   // Base Sepolia
  'eip155:137':      { name: 'USD Coin', version: '2' },   // Polygon mainnet
  'eip155:80002':    { name: 'USD Coin', version: '2' },   // Polygon Amoy
  'eip155:1':        { name: 'USD Coin', version: '2' },   // Ethereum mainnet
  'eip155:11155111': { name: 'USDC',     version: '2' },   // Ethereum Sepolia
};

/**
 * Known USDC contract addresses by CAIP-2 network ID.
 * Used to match `asset` fields against known USDC tokens when looking up
 * EIP-712 domain defaults.
 */
const KNOWN_USDC_ADDRESSES: Set<string> = new Set([
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Polygon mainnet
  '0x41E94Eb71Ef8C9863E91B9C684D4e1B9F5B1EeA5', // Polygon Amoy
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum mainnet
  '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // Ethereum Sepolia
]);

/**
 * Inject EIP-712 domain defaults into a PaymentRequired object.
 *
 * When a third-party x402 server omits `extra.name` and `extra.version` from
 * its 402 response, @x402/evm >= 2.7.0 throws because it needs these fields
 * to construct the EIP-712 domain for `transferWithAuthorization` signing.
 *
 * This function walks the `accepts` array and adds defaults for known USDC
 * tokens on supported chains. If the server already includes `extra.name`
 * and `extra.version`, those values are preserved (server takes precedence).
 *
 * If the asset/network combination is unrecognized, no defaults are injected
 * and @x402/evm will throw its normal error — this is intentional since we
 * can't guess the EIP-712 domain for arbitrary tokens.
 */
function injectEip712Defaults(paymentRequired: Record<string, unknown>): Record<string, unknown> {
  const accepts = paymentRequired.accepts;
  if (!accepts || !Array.isArray(accepts)) {
    return paymentRequired;
  }

  const enrichedAccepts = accepts.map((entry: Record<string, unknown>) => {
    const extra = (entry.extra ?? {}) as Record<string, unknown>;

    // If the server already provided name and version, keep them
    if (extra.name && extra.version) {
      return entry;
    }

    const network = String(entry.network ?? '');
    const asset = String(entry.asset ?? '');

    // Only inject defaults for known USDC tokens on known chains
    const domainDefaults = USDC_EIP712_DEFAULTS[network];
    if (!domainDefaults) {
      return entry;
    }

    // Verify this is actually a USDC token (case-insensitive address match)
    const isKnownUsdc = KNOWN_USDC_ADDRESSES.has(asset) ||
      [...KNOWN_USDC_ADDRESSES].some(addr => addr.toLowerCase() === asset.toLowerCase());

    if (!isKnownUsdc) {
      return entry;
    }

    return {
      ...entry,
      extra: {
        ...extra,
        // Only fill in missing fields — preserve any server-provided values
        name: extra.name ?? domainDefaults.name,
        version: extra.version ?? domainDefaults.version,
      },
    };
  });

  return {
    ...paymentRequired,
    accepts: enrichedAccepts,
  };
}

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

    const rawPaymentRequired = httpClient.getPaymentRequiredResponse(
      (name: string) => probeResponse.headers.get(name)
    ) as Record<string, unknown>;

    // Inject EIP-712 domain defaults for known USDC tokens.
    // Third-party x402 servers may omit extra.name/extra.version, which causes
    // @x402/evm >= 2.7.0 to throw "EIP-712 domain parameters (name, version)
    // are required". This fills in sensible defaults without overriding
    // server-provided values.
    const paymentRequired = injectEip712Defaults(rawPaymentRequired);

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
