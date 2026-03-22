import type { PayMuxServerConfig } from '../types.js';
import type { ChargeOptions } from '../../shared/types.js';

/**
 * MPP server protocol handler.
 *
 * Delegates to mppx/server which handles the full MPP protocol:
 * - HMAC-bound challenge generation (WWW-Authenticate: Payment)
 * - Authorization: Payment credential verification
 * - On-chain settlement on Tempo
 * - Payment-Receipt header generation
 *
 * We create the mppx server instance lazily and cache it per-config.
 */

interface MppxServerInstance {
  charge: (opts: { amount: string; description?: string }) =>
    (request: Request) => Promise<MppxChargeResult>;
}

interface MppxChargeResult {
  status: 402 | 200;
  challenge?: Response;
  withReceipt?: <T>(response: T) => T;
}

let cachedMppx: MppxServerInstance | null = null;
let cachedConfigKey: string | null = null;

/**
 * Get or create the mppx server instance.
 * Cached per unique config to avoid re-initialization on every request.
 */
async function getMppxServer(config: PayMuxServerConfig): Promise<MppxServerInstance> {
  if (!config.mpp) {
    throw new Error(
      'PayMux Server: MPP config is required. Pass mpp: { secretKey: "...", tempoRecipient: "0x..." }'
    );
  }

  // Cache key based on config values that affect initialization
  const configKey = `${config.mpp.secretKey}:${config.mpp.tempoRecipient}:${config.mpp.testnet}`;

  if (cachedMppx && cachedConfigKey === configKey) {
    return cachedMppx;
  }

  const { Mppx, tempo } = await import('mppx/server');

  const methods = [];

  // Tempo payment method (crypto-based)
  if (config.mpp.tempoRecipient) {
    methods.push(
      tempo({
        currency: '0x20c0000000000000000000000000000000000000', // PathUSD
        recipient: config.mpp.tempoRecipient,
        testnet: config.mpp.testnet ?? false,
      })
    );
  }

  // Stripe payment method (card-based) — if configured
  if (config.mpp.stripeSecretKey) {
    try {
      const { stripe } = await import('mppx/server');
      methods.push(
        stripe.charge({
          networkId: 'internal',
          paymentMethodTypes: ['card', 'link'],
          secretKey: config.mpp.stripeSecretKey,
        })
      );
    } catch {
      // Stripe method not available — continue with Tempo only
    }
  }

  if (methods.length === 0) {
    throw new Error(
      'PayMux Server: MPP requires at least one payment method. ' +
        'Pass mpp.tempoRecipient or mpp.stripeSecretKey.'
    );
  }

  const mppx = Mppx.create({
    methods,
    secretKey: config.mpp.secretKey,
    realm: config.mpp.realm ?? 'paymux',
  });

  cachedMppx = mppx as unknown as MppxServerInstance;
  cachedConfigKey = configKey;
  return cachedMppx;
}

/**
 * Handle an MPP payment request.
 *
 * Uses mppx.charge() which returns:
 * - { status: 402, challenge: Response } — no payment, return the 402 challenge
 * - { status: 200, withReceipt: fn } — payment verified, wrap response with receipt
 */
export async function handleMppRequest(
  request: Request,
  config: PayMuxServerConfig,
  chargeOpts: ChargeOptions
): Promise<{
  handled: boolean;
  status?: 402 | 200;
  challengeResponse?: Response;
  withReceipt?: <T>(response: T) => T;
  error?: string;
}> {
  try {
    const mppx = await getMppxServer(config);

    const result = await mppx.charge({
      amount: String(chargeOpts.amount),
      description: chargeOpts.description,
    })(request);

    if (result.status === 402) {
      return {
        handled: true,
        status: 402,
        challengeResponse: result.challenge,
      };
    }

    if (result.status === 200) {
      return {
        handled: true,
        status: 200,
        withReceipt: result.withReceipt,
      };
    }

    return { handled: false, error: 'Unexpected mppx charge result' };
  } catch (error) {
    return {
      handled: false,
      error: `MPP handler error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
