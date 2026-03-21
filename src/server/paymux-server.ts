import type { PayMuxServerConfig, ChargeOptions, PayMuxMiddleware } from './types.js';
import { createExpressCharge } from './middleware/express.js';
import { createHonoCharge } from './middleware/hono.js';

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
      console.warn(
        '[paymux] Warning: MPP server support ships in v0.2.0. ' +
          'MPP will be ignored in the accept[] array for now. Only x402 is active.'
      );
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
    return function paymuxCharge(...args: unknown[]): unknown {
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
