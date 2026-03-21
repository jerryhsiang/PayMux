/**
 * PayMux — The easiest way to make your API agent-payable.
 *
 * Client SDK for AI agents that need to pay for services.
 * Auto-detects protocol (x402, MPP, card), routes optimally, handles 402 challenges.
 *
 * @example
 * ```typescript
 * import { PayMux } from 'paymux';
 *
 * const agent = PayMux.create({
 *   wallet: { privateKey: '0x...' },
 *   limits: { perRequest: 1.00, perDay: 200.00 },
 * });
 *
 * const response = await agent.fetch('https://api.example.com/data');
 * ```
 *
 * @packageDocumentation
 */

export { PayMux } from './client/paymux.js';
export type { PayMuxClient } from './client/paymux.js';
export { SpendingLimitError } from './client/spending.js';

// Types
export type { PayMuxConfig, PayMuxFetchOptions } from './client/types.js';
export type {
  Protocol,
  Chain,
  PaymentResult,
  PaymentRequirement,
  WalletConfig,
  CardConfig,
  SpendingLimits,
} from './shared/types.js';
