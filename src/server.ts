/**
 * PayMux Server — Accept payments from any AI agent, any protocol.
 *
 * Server middleware for API developers who want to monetize their endpoints.
 * One middleware accepts x402, MPP, and card payments.
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
 * app.get('/api/data',
 *   payments.charge({ amount: 0.01, currency: 'USD' }),
 *   (req, res) => res.json({ data: 'protected' })
 * );
 * ```
 *
 * @packageDocumentation
 */

export { PayMuxServer, PayMuxServerInstance } from './server/paymux-server.js';

// Types
export type {
  PayMuxServerConfig,
  ChargeOptions,
  PayMuxMiddleware,
  ExpressPayMuxMiddleware,
  HonoPayMuxMiddleware,
} from './server/types.js';
export type {
  Protocol,
  Chain,
} from './shared/types.js';
