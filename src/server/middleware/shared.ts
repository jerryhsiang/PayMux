import type { PayMuxServerConfig } from '../types.js';
import type { ChargeOptions } from '../../shared/types.js';
import { generateX402Requirements } from '../protocols/x402.js';

/**
 * Build payment requirements for all configured protocols.
 *
 * Currently supports x402 only. MPP support (using WWW-Authenticate: Payment)
 * will be added in v0.2.0.
 */
export function buildPaymentRequirements(
  config: PayMuxServerConfig,
  chargeOpts: ChargeOptions,
  resource: string
): {
  paymentRequired: string;
  body: Record<string, unknown>;
} {
  // x402 requirements via PAYMENT-REQUIRED header
  if (config.accept.includes('x402') && config.x402) {
    const x402Req = generateX402Requirements(config, chargeOpts, resource);
    return {
      paymentRequired: x402Req,
      body: JSON.parse(atob(x402Req)),
    };
  }

  // MPP uses WWW-Authenticate: Payment (different header entirely).
  // It should NOT be stuffed into the PAYMENT-REQUIRED JSON body.
  // MPP server support ships in v0.2.0.

  return {
    paymentRequired: btoa(JSON.stringify({ x402Version: 2, accepts: [] })),
    body: { x402Version: 2, accepts: [] },
  };
}
