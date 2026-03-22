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
 * Universal PayMux middleware returned by charge().
 * Works as Express middleware (3 args) or Hono middleware (2 args).
 */
export type PayMuxMiddleware = (...args: unknown[]) => unknown;

export type { ChargeOptions };
