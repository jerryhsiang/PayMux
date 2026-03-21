import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';
import type { PayMuxServerConfig } from '../types.js';
import type { ChargeOptions } from '../../shared/types.js';
import { verifyX402Payment, settleX402Payment } from '../protocols/x402.js';
import { buildPaymentRequirements } from './shared.js';

/**
 * Create Express middleware that gates an endpoint behind payment.
 *
 * @example
 * ```typescript
 * app.get('/api/data',
 *   payments.charge({ amount: 0.01, currency: 'USD' }),
 *   (req, res) => res.json({ data: 'protected' })
 * );
 * ```
 */
export function createExpressCharge(
  config: PayMuxServerConfig,
  chargeOpts: ChargeOptions
) {
  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    try {
      // Check for x402 PAYMENT-SIGNATURE header only (spec-compliant)
      const paymentSignature = req.headers['payment-signature'] as string | undefined;

      if (!paymentSignature) {
        // No payment — return 402 with payment requirements
        const resource = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;
        const requirements = buildPaymentRequirements(config, chargeOpts, resource);

        res.status(402);
        res.setHeader('Payment-Required', requirements.paymentRequired);

        res.json({
          error: 'Payment Required',
          message: `This endpoint requires a payment of ${chargeOpts.amount} ${chargeOpts.currency ?? 'USD'}`,
          protocols: config.accept,
        });
        return;
      }

      // Has payment — verify and settle
      const standardRequest = expressToRequest(req);

      if (config.accept.includes('x402') && config.x402) {
        const verification = await verifyX402Payment(standardRequest, config, chargeOpts);

        if (verification.valid) {
          const settlement = await settleX402Payment(standardRequest, config, chargeOpts);

          // Issue #8: Always set Payment-Response header, even without transaction hash
          res.setHeader(
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
            next();
            return;
          }
        }
      }

      // Payment verification or settlement failed
      res.status(402).json({
        error: 'Payment Required',
        message: 'Payment verification failed. Please retry with a valid payment.',
      });
    } catch (error) {
      // Express 4 does not handle async errors — pass to error handler
      next(error);
    }
  };
}

/**
 * Convert an Express Request to a standard Fetch API Request.
 *
 * Forwards headers and body so downstream protocol handlers
 * can access the full request payload when needed.
 */
function expressToRequest(req: ExpressRequest): Request {
  const protocol = req.protocol ?? 'http';
  const host = req.get('host') ?? 'localhost';
  const url = `${protocol}://${host}${req.originalUrl}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      value.forEach((v) => headers.append(key, v));
    }
  }

  // Issue #3: Forward request body for future protocols that may need it.
  // GET and HEAD requests must not have a body per the Fetch spec.
  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  let body: string | Buffer | undefined;

  if (hasBody && req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      body = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      body = req.body;
    } else if (typeof req.body === 'object') {
      body = JSON.stringify(req.body);
      // Ensure content-type is set when we serialize the body
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
    }
  }

  return new Request(url, {
    method: req.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}
