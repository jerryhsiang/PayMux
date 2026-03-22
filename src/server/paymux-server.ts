import type { PayMuxServerConfig, ChargeOptions, PayMuxMiddleware } from './types.js';
import type { Chain } from '../shared/types.js';
import { createExpressCharge } from './middleware/express.js';
import { createHonoCharge } from './middleware/hono.js';

/**
 * Known named chains that PayMux supports.
 * CAIP-2 format chains (eip155:*, solana:*) are also accepted.
 */
const VALID_NAMED_CHAINS = new Set<string>([
  'base',
  'base-sepolia',
  'polygon',
  'solana',
]);

/**
 * Validate that a chain value is recognized.
 * Accepts named chains (base, base-sepolia, polygon, solana) and
 * CAIP-2 format chains (eip155:<number>, solana:<string>).
 * Returns an error message if invalid, or null if valid.
 */
function validateChain(chain: Chain): string | null {
  // Accept known named chains
  if (VALID_NAMED_CHAINS.has(chain)) return null;

  // Accept CAIP-2 EVM chains: eip155:<number>
  if (/^eip155:\d+$/.test(chain)) return null;

  // Accept CAIP-2 Solana chains: solana:<string>
  if (/^solana:.+$/.test(chain)) return null;

  const validList = [...VALID_NAMED_CHAINS].sort().join(', ');
  return (
    `PayMux Server: Unknown chain "${chain}". ` +
    `Valid chains: ${validList}, or CAIP-2 format (eip155:<chainId>, solana:<cluster>)`
  );
}

/** Common placeholder patterns that should be rejected */
const ETH_ADDRESS_PLACEHOLDERS = new Set([
  '0x0000000000000000000000000000000000000000', // zero address
]);

const ETH_ADDRESS_PLACEHOLDER_PATTERNS = [
  /your/i,   // 0xYourWalletAddress, 0xYOUR_ADDRESS, etc.
  /example/i, // 0xExampleAddress
  /replace/i, // 0xReplaceMe
  /insert/i,  // 0xInsertHere
  /todo/i,    // 0xTODO
  /placeholder/i,
  /^0x\.{3,}$/,  // 0x...
  /^0xx+$/i,     // 0xxxxx
];

/**
 * Validate that a string is a valid Ethereum address and not a placeholder.
 * Returns an error message if invalid, or null if valid.
 */
function validateEthAddress(address: string, fieldName: string): string | null {
  // Must start with 0x and be exactly 42 characters
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return (
      `PayMux Server: ${fieldName} is not a valid Ethereum address. ` +
      `Got: "${address}". ` +
      `Expected format: 0x followed by 40 hex characters (e.g., 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18)`
    );
  }

  // Check known placeholder addresses
  if (ETH_ADDRESS_PLACEHOLDERS.has(address.toLowerCase())) {
    return (
      `PayMux Server: ${fieldName} is a placeholder address (zero address). ` +
      `Got: "${address}". ` +
      `Provide a real wallet address to receive payments.`
    );
  }

  return null;
}

/**
 * Validate that an address string is not a placeholder pattern (catches non-hex placeholders).
 * Called before hex validation to give a better error message.
 * Returns an error message if it matches a placeholder, or null otherwise.
 */
function checkPlaceholderPattern(address: string, fieldName: string): string | null {
  for (const pattern of ETH_ADDRESS_PLACEHOLDER_PATTERNS) {
    if (pattern.test(address)) {
      return (
        `PayMux Server: ${fieldName} is not a valid Ethereum address. ` +
        `Got: "${address}". ` +
        `Expected format: 0x followed by 40 hex characters (e.g., 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18)`
      );
    }
  }
  return null;
}

/**
 * PayMuxServer — Accept payments from any AI agent, any protocol.
 *
 * @example
 * ```typescript
 * import { PayMuxServer } from 'paymux/server';
 *
 * const payments = PayMuxServer.create({
 *   accept: ['x402'],
 *   x402: { recipient: '0x...', chain: 'base' },
 * });
 *
 * // Express
 * app.get('/api/data',
 *   payments.charge({ amount: 0.01, currency: 'USD' }),
 *   (req, res) => res.json({ data: 'protected' })
 * );
 *
 * // Hono
 * app.get('/api/data',
 *   payments.charge({ amount: 0.01, currency: 'USD' }),
 *   (c) => c.json({ data: 'protected' })
 * );
 * ```
 */
export class PayMuxServer {
  /**
   * Create a new PayMuxServer instance
   */
  static create(config: PayMuxServerConfig): PayMuxServerInstance {
    // Validate config
    if (!config.accept || config.accept.length === 0) {
      throw new Error(
        'PayMux Server: at least one protocol must be specified in accept[]'
      );
    }

    if (config.accept.includes('x402') && !config.x402) {
      throw new Error(
        'PayMux Server: x402 is in accept[] but x402 config is missing. ' +
          'Pass x402: { recipient: "0x...", chain: "base" }'
      );
    }

    if (config.accept.includes('mpp')) {
      if (!config.mpp) {
        throw new Error(
          'PayMux Server: mpp is in accept[] but mpp config is missing. ' +
            'Pass mpp: { secretKey: "...", tempoRecipient: "0x..." }'
        );
      }
      if (!config.mpp.secretKey) {
        throw new Error(
          'PayMux Server: mpp.secretKey is required for MPP challenge binding. ' +
            'Generate one with: crypto.randomBytes(32).toString("base64")'
        );
      }
      if (config.mpp.secretKey.length < 32) {
        throw new Error(
          'PayMux Server: mpp.secretKey must be at least 32 characters for secure HMAC challenge binding. ' +
            `Got ${config.mpp.secretKey.length} characters. ` +
            'Generate one with: crypto.randomBytes(32).toString("base64")'
        );
      }
    }

    // Validate Ethereum addresses are real, not placeholders
    if (config.x402?.recipient) {
      const placeholderErr = checkPlaceholderPattern(config.x402.recipient, 'x402.recipient');
      if (placeholderErr) throw new Error(placeholderErr);

      const addrErr = validateEthAddress(config.x402.recipient, 'x402.recipient');
      if (addrErr) throw new Error(addrErr);
    }

    if (config.mpp?.tempoRecipient) {
      const placeholderErr = checkPlaceholderPattern(config.mpp.tempoRecipient, 'mpp.tempoRecipient');
      if (placeholderErr) throw new Error(placeholderErr);

      const addrErr = validateEthAddress(config.mpp.tempoRecipient, 'mpp.tempoRecipient');
      if (addrErr) throw new Error(addrErr);
    }

    // Issue #9: Validate facilitator URL enforces HTTPS
    if (config.x402?.facilitator) {
      const facilitatorUrl = config.x402.facilitator;
      if (!facilitatorUrl.startsWith('https://')) {
        throw new Error(
          'PayMux Server: x402 facilitator URL must use HTTPS. ' +
            `Got: "${facilitatorUrl}"`
        );
      }
    }

    // Validate chain is a known value (catches typos like "ethereum-goerli")
    if (config.x402?.chain) {
      const chainErr = validateChain(config.x402.chain);
      if (chainErr) throw new Error(chainErr);
    }

    return new PayMuxServerInstance(config);
  }
}

/**
 * PayMuxServer instance — creates payment-gating middleware
 */
export class PayMuxServerInstance {
  private config: Readonly<PayMuxServerConfig>;

  constructor(config: PayMuxServerConfig) {
    // Issue #5: Freeze a deep clone so external mutation cannot change behavior
    this.config = Object.freeze(structuredClone(config));
  }

  /**
   * Create middleware that requires payment before processing the request.
   *
   * Returns a middleware function compatible with Express and Hono.
   * Framework is auto-detected based on the arguments passed to the middleware.
   */
  charge(opts: ChargeOptions): PayMuxMiddleware {
    // Issue #2: Validate amount is positive, finite, and not NaN
    if (typeof opts.amount !== 'number' || !Number.isFinite(opts.amount) || opts.amount <= 0) {
      throw new Error(
        'PayMux Server: charge() amount must be a positive, finite number. ' +
          `Got: ${opts.amount}`
      );
    }

    const config = this.config;
    const chargeOpts: ChargeOptions = {
      currency: 'USD',
      ...opts,
    };

    // Return a universal middleware that auto-detects Express vs Hono
    // Express passes (req, res, next) — 3 args
    // Hono passes (c, next) — 2 args
    const expressMiddleware = createExpressCharge(config, chargeOpts);
    const honoMiddleware = createHonoCharge(config, chargeOpts);

    // TODO: Add rate limiting per IP / per agent to prevent abuse.
    // Rate limiting should be configurable via PayMuxServerConfig and
    // enforce limits before payment verification to reduce facilitator load.

    // Return a function that detects the framework by argument count
    return function paymuxCharge(...args: any[]): void | Promise<void> {
      if (args.length >= 3) {
        // Express: (req, res, next)
        return (expressMiddleware as Function).apply(null, args);
      } else if (args.length === 2) {
        // Hono: (c, next)
        return (honoMiddleware as Function).apply(null, args);
      }
      throw new Error(
        'PayMux Server: charge() middleware received unexpected arguments. ' +
          'Ensure you are using Express or Hono.'
      );
    };
  }

  /**
   * Get the server configuration
   */
  get protocols(): string[] {
    return [...this.config.accept];
  }
}
