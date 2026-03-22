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

/** Per-config instance cache. Keyed by hashed config values, not raw secrets. */
const instanceCache = new Map<string, MppxServerInstance>();

const MIN_SECRET_KEY_LENGTH = 32;

/**
 * Fast, non-cryptographic hash for cache key differentiation.
 * Uses FNV-1a (32-bit). This is NOT for security — the mppx instance holds
 * the secret in memory regardless. We hash only to avoid keeping the raw
 * secret key as a Map key string that could surface in heap dumps / debuggers.
 *
 * Works in Node, Deno, Bun, and Cloudflare Workers (no `crypto` import needed).
 */
function hashConfigKey(secretKey: string, recipient: string, testnet: string): string {
  const input = `${secretKey}:${recipient}:${testnet}`;
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime multiply — use Math.imul for correct 32-bit overflow
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned 32-bit hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Get or create the mppx server instance.
 * Cached per unique config so multiple PayMuxServer instances with different
 * merchant configs can coexist without overwriting each other.
 */
async function getMppxServer(config: PayMuxServerConfig): Promise<MppxServerInstance> {
  if (!config.mpp) {
    throw new Error(
      'PayMux Server: MPP config is required. Pass mpp: { secretKey: "...", tempoRecipient: "0x..." }'
    );
  }

  if (config.mpp.secretKey.length < MIN_SECRET_KEY_LENGTH) {
    throw new Error(
      `PayMux Server: MPP secretKey must be at least ${MIN_SECRET_KEY_LENGTH} characters. ` +
        'Generate one with: crypto.randomBytes(32).toString(\'base64\')'
    );
  }

  // Hash the config values — avoids storing the raw secret as a cache key
  const configKey = hashConfigKey(
    config.mpp.secretKey,
    config.mpp.tempoRecipient ?? '',
    String(config.mpp.testnet ?? false),
  );

  const cached = instanceCache.get(configKey);
  if (cached) {
    return cached;
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

  const instance = mppx as unknown as MppxServerInstance;
  instanceCache.set(configKey, instance);
  return instance;
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
