import type { Context, Next, MiddlewareHandler } from 'hono';
import type { PayMuxServerConfig } from '../types.js';
import type { ChargeOptions } from '../../shared/types.js';
import { verifyX402Payment, settleX402Payment } from '../protocols/x402.js';
import { handleMppRequest } from '../protocols/mpp.js';
import { buildPaymentRequirements } from './shared.js';

/**
 * Create Hono middleware that gates an endpoint behind payment.
 *
 * Supports both x402 and MPP protocols. Works with Cloudflare Workers,
 * Deno, Bun, and Node.js.
 */
export function createHonoCharge(
  config: PayMuxServerConfig,
  chargeOpts: ChargeOptions
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Detect payment protocol from headers
    const hasX402 = !!c.req.header('payment-signature');
    const authHeader = c.req.header('authorization');
    const hasMpp = authHeader?.startsWith('Payment ') ?? false;

    if (!hasX402 && !hasMpp) {
      // No payment — return 402 with requirements for all supported protocols
      const resource = c.req.url;
      const requirements = buildPaymentRequirements(config, chargeOpts, resource);

      // If MPP is configured, delegate to mppx to generate the proper
      // HMAC-bound WWW-Authenticate: Payment challenge header. mppx needs
      // the actual request to produce the challenge — we can't pre-generate it.
      if (config.accept.includes('mpp') && config.mpp) {
        const mppResult = await handleMppRequest(c.req.raw, config, chargeOpts);

        if (mppResult.handled && mppResult.status === 402 && mppResult.challengeResponse) {
          // Clone the mppx challenge response so we can add x402 headers alongside it
          const challengeHeaders = new Headers(mppResult.challengeResponse.headers);

          // Include x402 PAYMENT-REQUIRED header alongside the MPP challenge
          if (requirements.paymentRequired) {
            challengeHeaders.set('Payment-Required', requirements.paymentRequired);
          }

          const body = await mppResult.challengeResponse.text();
          return new Response(body, {
            status: 402,
            headers: challengeHeaders,
          });
        }
      }

      // Fallback: no MPP configured or MPP challenge generation failed.
      // Return static 402 with whatever headers are available.
      c.status(402);
      if (requirements.paymentRequired) {
        c.header('Payment-Required', requirements.paymentRequired);
      }
      if (requirements.wwwAuthenticate) {
        c.header('WWW-Authenticate', requirements.wwwAuthenticate);
      }

      return c.json({
        error: 'Payment Required',
        message: `This endpoint requires a payment of ${chargeOpts.amount} ${chargeOpts.currency ?? 'USD'}`,
        protocols: config.accept,
      });
    }

    // MPP payment path — delegate to mppx
    if (hasMpp && config.accept.includes('mpp') && config.mpp) {
      const mppResult = await handleMppRequest(c.req.raw, config, chargeOpts);

      if (mppResult.handled) {
        if (mppResult.status === 402 && mppResult.challengeResponse) {
          // Return the mppx challenge response directly
          return mppResult.challengeResponse;
        }

        if (mppResult.status === 200 && mppResult.withReceipt) {
          // Payment verified — continue to handler, then wrap response with receipt
          await next();
          // Wrap the response to attach Payment-Receipt header
          c.res = mppResult.withReceipt(c.res);
          return;
        }
      }
      // MPP handling failed — fall through to 402
    }

    // x402 payment path
    if (hasX402 && config.accept.includes('x402') && config.x402) {
      const verification = await verifyX402Payment(c.req.raw, config, chargeOpts);

      if (verification.valid) {
        const settlement = await settleX402Payment(c.req.raw, config, chargeOpts);

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

    // Payment verification failed
    c.status(402);
    return c.json({
      error: 'Payment Required',
      message: 'Payment verification failed. Please retry with a valid payment.',
    });
  };
}
