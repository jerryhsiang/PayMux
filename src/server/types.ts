import type { Protocol, Chain, ChargeOptions } from '../shared/types.js';

/**
 * Configuration for creating a PayMuxServer instance
 */
export interface PayMuxServerConfig {
  /** Which protocols to accept payments from */
  accept: Protocol[];

  /** x402 configuration */
  x402?: {
    /** Recipient wallet address */
    recipient: `0x${string}`;
    /** Chain to settle on (default: 'base') */
    chain?: Chain;
    /** Facilitator URL (default: 'https://x402.org/facilitator') */
    facilitator?: string;
    /** Token contract address (default: USDC on selected chain) */
    asset?: string;
    /** Timeout in ms for facilitator verify calls (default: 30000) */
    verifyTimeoutMs?: number;
    /** Timeout in ms for facilitator settle calls (default: 60000) */
    settleTimeoutMs?: number;
  };

  /** MPP configuration (Stripe/Tempo) */
  mpp?: {
    /** HMAC secret key for challenge binding (required). Generate with: crypto.randomBytes(32).toString('base64') */
    secretKey: string;
    /** Tempo recipient address */
    tempoRecipient?: `0x${string}`;
    /** Use Tempo testnet (default: false) */
    testnet?: boolean;
    /** Stripe secret key (for card-based MPP via Stripe) */
    stripeSecretKey?: string;
    /** Realm identifier (default: auto-detected) */
    realm?: string;
  };

  /** Card configuration — future release */
  card?: {
    stripeSecretKey?: string;
  };

  /** Preferred settlement rail when agent supports multiple */
  preferredRail?: Protocol;
}

/**
 * Framework-agnostic middleware function
 */
export type MiddlewareHandler = (
  request: Request
) => Promise<Response | null>;

/**
 * Middleware typed for Express. Cast from `charge()` when using Express.
 *
 * @example
 * ```typescript
 * const mw = payments.charge({ amount: 0.01 }) as ExpressPayMuxMiddleware;
 * app.get('/api/data', mw, handler);
 * ```
 */
export type ExpressPayMuxMiddleware = (
  req: { headers: Record<string, string | string[] | undefined>; method: string; url: string; protocol: string; originalUrl: string; get: (name: string) => string | undefined; body?: unknown },
  res: { status: (code: number) => any; json: (body: any) => any; setHeader: (name: string, value: string) => any; send: (body: any) => any },
  next: (err?: any) => void
) => void | Promise<void>;

/**
 * Middleware typed for Hono. Cast from `charge()` when using Hono.
 *
 * @example
 * ```typescript
 * const mw = payments.charge({ amount: 0.01 }) as HonoPayMuxMiddleware;
 * app.get('/api/data', mw, handler);
 * ```
 */
export type HonoPayMuxMiddleware = (
  c: { req: { raw: Request; url: string; header: (name: string) => string | undefined }; json: (body: any, status?: number) => any; header: (name: string, value: string) => void; status: (code: number) => void; res: Response },
  next: () => Promise<void>
) => void | Promise<void>;

/**
 * Universal payment middleware returned by `charge()`.
 * Auto-detects Express (3 args) or Hono (2 args) at runtime.
 *
 * For full IDE type safety, cast to `ExpressPayMuxMiddleware` or `HonoPayMuxMiddleware`:
 *
 * @example
 * ```typescript
 * // Express
 * const mw = payments.charge({ amount: 0.01 }) as ExpressPayMuxMiddleware;
 *
 * // Hono
 * const mw = payments.charge({ amount: 0.01 }) as HonoPayMuxMiddleware;
 * ```
 */
export type PayMuxMiddleware = ((...args: any[]) => void | Promise<void>)
  & { __brand?: 'PayMuxMiddleware' };

export type { ChargeOptions };
