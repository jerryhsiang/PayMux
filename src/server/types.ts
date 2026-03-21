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
    /** Facilitator URL (default: 'https://facilitator.x402.org') */
    facilitator?: string;
    /** Token to accept (default: 'USDC') */
    asset?: string;
  };

  /** MPP configuration (Stripe/Tempo) */
  mpp?: {
    /** Stripe secret key (for card-based MPP) */
    stripeSecretKey?: string;
    /** Tempo recipient address (for crypto-based MPP) */
    tempoRecipient?: `0x${string}`;
  };

  /** Card configuration — week 12 */
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
 *
 * Works as both Express middleware (req, res, next — 3 args) and
 * Hono middleware (c, next — 2 args). Framework is auto-detected
 * based on argument count at call time.
 */
export type PayMuxMiddleware = (...args: unknown[]) => unknown;

export type { ChargeOptions };
