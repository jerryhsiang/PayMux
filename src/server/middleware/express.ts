import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';
import type { PayMuxServerConfig } from '../types.js';
import type { ChargeOptions } from '../../shared/types.js';
import { verifyX402Payment, settleX402Payment } from '../protocols/x402.js';
import { handleMppRequest } from '../protocols/mpp.js';
import { buildPaymentRequirements } from './shared.js';

/**
 * Create Express middleware that gates an endpoint behind payment.
 *
 * Supports both x402 and MPP protocols. Detects which protocol the
 * incoming request uses based on headers:
 * - x402: PAYMENT-SIGNATURE header
 * - MPP: Authorization: Payment header
 */
export function createExpressCharge(
  config: PayMuxServerConfig,
  chargeOpts: ChargeOptions
) {
  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    try {
      // Detect payment protocol from headers
      const hasX402 = !!req.headers['payment-signature'];
      const authHeader = req.headers['authorization'] as string | undefined;
      const hasMpp = authHeader?.startsWith('Payment ') ?? false;

      if (!hasX402 && !hasMpp) {
        // No payment — return 402 with requirements for all supported protocols
        const resource = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;
        const requirements = buildPaymentRequirements(config, chargeOpts, resource);

        res.status(402);
        // x402 requirements in PAYMENT-REQUIRED header
        if (requirements.paymentRequired) {
          res.setHeader('Payment-Required', requirements.paymentRequired);
        }
        // MPP requirements in WWW-Authenticate header
        if (requirements.wwwAuthenticate) {
          res.setHeader('WWW-Authenticate', requirements.wwwAuthenticate);
        }

        res.json({
          error: 'Payment Required',
          message: `This endpoint requires a payment of ${chargeOpts.amount} ${chargeOpts.currency ?? 'USD'}`,
          protocols: config.accept,
        });
        return;
      }

      // MPP payment path — delegate to mppx
      if (hasMpp && config.accept.includes('mpp') && config.mpp) {
        const standardRequest = expressToRequest(req);
        const mppResult = await handleMppRequest(standardRequest, config, chargeOpts);

        if (mppResult.handled) {
          if (mppResult.status === 402 && mppResult.challengeResponse) {
            // Forward the mppx challenge response
            res.status(402);
            mppResult.challengeResponse.headers.forEach((value, key) => {
              res.setHeader(key, value);
            });
            const body = await mppResult.challengeResponse.text();
            res.send(body);
            return;
          }

          if (mppResult.status === 200 && mppResult.withReceipt) {
            // Payment verified — wrap the response with Payment-Receipt header
            const originalJson = res.json.bind(res);
            res.json = function (data: unknown) {
              // Create a temporary Response to let mppx attach the receipt
              const tempResponse = new Response(JSON.stringify(data), {
                headers: { 'Content-Type': 'application/json' },
              });
              const receiptedResponse = mppResult.withReceipt!(tempResponse);
              // Copy the Payment-Receipt header to the Express response
              const receipt = receiptedResponse.headers.get('payment-receipt');
              if (receipt) {
                res.setHeader('Payment-Receipt', receipt);
              }
              return originalJson(data);
            } as typeof res.json;
            next();
            return;
          }
        }
        // MPP handling failed — fall through to 402
      }

      // x402 payment path
      if (hasX402 && config.accept.includes('x402') && config.x402) {
        const standardRequest = expressToRequest(req);
        const verification = await verifyX402Payment(standardRequest, config, chargeOpts);

        if (verification.valid) {
          const settlement = await settleX402Payment(standardRequest, config, chargeOpts);

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

      // Payment verification failed
      res.status(402).json({
        error: 'Payment Required',
        message: 'Payment verification failed. Please retry with a valid payment.',
      });
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Convert an Express Request to a standard Fetch API Request.
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
