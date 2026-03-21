import type { Context, Next, MiddlewareHandler } from 'hono';
import type { PayMuxServerConfig } from '../types.js';
import type { ChargeOptions } from '../../shared/types.js';
import { verifyX402Payment, settleX402Payment } from '../protocols/x402.js';
import { buildPaymentRequirements } from './shared.js';

/**
 * Create Hono middleware that gates an endpoint behind payment.
 *
 * Works with Cloudflare Workers, Deno, Bun, and Node.js.
 *
 * @example
 * ```typescript
 * app.get('/api/data',
 *   payments.charge({ amount: 0.01, currency: 'USD' }),
 *   (c) => c.json({ data: 'protected' })
 * );
 * ```
 */
export function createHonoCharge(
  config: PayMuxServerConfig,
  chargeOpts: ChargeOptions
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Check for x402 PAYMENT-SIGNATURE header only (spec-compliant)
    const paymentSignature = c.req.header('payment-signature');

    if (!paymentSignature) {
      // No payment — return 402 with payment requirements
      const resource = c.req.url;
      const requirements = buildPaymentRequirements(config, chargeOpts, resource);

      c.status(402);
      c.header('Payment-Required', requirements.paymentRequired);

      return c.json({
        error: 'Payment Required',
        message: `This endpoint requires a payment of ${chargeOpts.amount} ${chargeOpts.currency ?? 'USD'}`,
        protocols: config.accept,
      });
    }

    // Has payment — verify and settle
    const request = c.req.raw;

    if (config.accept.includes('x402') && config.x402) {
      const verification = await verifyX402Payment(request, config, chargeOpts);

      if (verification.valid) {
        const settlement = await settleX402Payment(request, config, chargeOpts);

        // Issue #8: Always set Payment-Response header, even without transaction hash
        c.header(
          'Payment-Response',
          btoa(
            JSON.stringify({
              success: settlement.settled,
              transaction: settlement.transaction ?? '',
              network: config.x402?.chain ?? 'base',
            })
          )
        );

        if (settlement.settled) {
          await next();
          return;
        }
      }
    }

    // Payment verification or settlement failed
    c.status(402);
    return c.json({
      error: 'Payment Required',
      message: 'Payment verification failed. Please retry with a valid payment.',
    });
  };
}
