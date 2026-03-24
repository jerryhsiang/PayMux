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

/**
 * A charge handler: call with options to get a request handler, then call
 * with the Request to get the MPP result.
 *
 * Derived from mppx's `Mppx.compose()` return type — a function from
 * `Request` to `Promise<{ status: 402; challenge: Response } | { status: 200; withReceipt: (r: Response) => Response }>`.
 */
type MppChargeHandler = (request: Request) => Promise<MppChargeResult>;

type MppChargeResult =
  | { status: 402; challenge: Response }
  | { status: 200; withReceipt: (response: Response) => Response };

/**
 * Cached charge factory: takes amount/description, returns an MppChargeHandler.
 * Built from the mppx instance at creation time so we don't need to store
 * (or type) the polymorphic mppx instance itself.
 */
type ChargeFactory = (opts: { amount: string; description?: string }) => MppChargeHandler;

/** Cached entry: factory + original config values for collision detection + creation time for TTL */
interface CacheEntry {
  factory: ChargeFactory;
  /** Original config values for collision detection (not the secret itself) */
  recipient: string;
  testnet: string;
  /** When this entry was created (ms since epoch) */
  createdAt: number;
}

/** Per-config factory cache. Keyed by hashed config values, not raw secrets. */
const factoryCache = new Map<string, CacheEntry>();

/** Maximum number of cached factory entries (prevents unbounded growth from key rotation) */
const MAX_FACTORY_CACHE_SIZE = 50;

/** TTL for factory cache entries (1 hour). Ensures rotated secrets are eventually evicted. */
const FACTORY_CACHE_TTL_MS = 60 * 60 * 1000;

const MIN_SECRET_KEY_LENGTH = 32;

/**
 * Fast, non-cryptographic hash for cache key differentiation.
 * Uses FNV-1a (32-bit) combined with DJB2 for a 64-bit key space,
 * vastly reducing collision risk compared to a single 32-bit hash.
 *
 * The cache also performs full config comparison on hit (H4 fix) for
 * collision safety in multi-tenant deployments.
 *
 * Works in Node, Deno, Bun, and Cloudflare Workers (no `crypto` import needed).
 */
function hashConfigKey(secretKey: string, recipient: string, testnet: string): string {
  const input = `${secretKey}:${recipient}:${testnet}`;
  // Primary hash: FNV-1a 32-bit
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  // Secondary hash: DJB2
  let h2 = 5381;
  for (let i = 0; i < input.length; i++) {
    h2 = ((h2 << 5) + h2 + input.charCodeAt(i)) | 0;
  }
  // Combine both hashes for 64-bit key space
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Evict expired entries from the factory cache.
 * Called before inserting new entries to keep the cache bounded.
 */
function evictExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of factoryCache) {
    if (now - entry.createdAt > FACTORY_CACHE_TTL_MS) {
      factoryCache.delete(key);
    }
  }
}

/**
 * Get or create an MPP charge factory.
 * Cached per unique config so multiple PayMuxServer instances with different
 * merchant configs can coexist without overwriting each other.
 *
 * Instead of caching the raw mppx instance (whose type is heavily generic and
 * would require an unsafe double-cast), we build a ChargeFactory that uses
 * `Mppx.compose()` — a standalone function with a concrete, exported signature.
 * This gives us proper types without any `as unknown as` casts.
 */
async function getMppChargeFactory(config: PayMuxServerConfig): Promise<ChargeFactory> {
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

  const recipient = config.mpp.tempoRecipient ?? '';
  const testnet = String(config.mpp.testnet ?? false);

  // Hash the config values — avoids storing the raw secret as a cache key
  const configKey = hashConfigKey(config.mpp.secretKey, recipient, testnet);

  const cached = factoryCache.get(configKey);
  if (cached) {
    // Collision check: verify the config values match (H4 fix).
    // Even with 64-bit hash, check actual values to be safe in
    // multi-tenant deployments where a collision = wrong recipient.
    if (
      cached.recipient === recipient &&
      cached.testnet === testnet &&
      Date.now() - cached.createdAt < FACTORY_CACHE_TTL_MS
    ) {
      return cached.factory;
    }
    // Collision or expired — evict and recreate
    factoryCache.delete(configKey);
  }

  const { Mppx, tempo } = await import('mppx/server');

  const methods = [];

  // Tempo payment method (crypto-based)
  // Omit `currency` to let mppx use its chain-appropriate default:
  // - Testnet (chainId 42431): PathUSD 0x20c0000000000000000000000000000000000000
  // - Mainnet (chainId 4217): USDC 0x20C000000000000000000000b9537d11c60E8b50
  if (config.mpp.tempoRecipient) {
    methods.push(
      tempo({
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

  // Build a charge factory using Mppx.compose(), which has a concrete exported
  // type signature: (...handlers) => (Request) => Promise<Response>.
  // This avoids the `as unknown as` double-cast on the polymorphic mppx instance.
  //
  // mppx.charge(...) is a shorthand intent accessor that returns a typed handler
  // function `(Request) => Promise<Response>`. We access it via bracket notation
  // since the 'charge' key is dynamically generated from the method intents.
  // The compose() wrapper merges multiple method challenges into a single 402.
  const chargeAccessor = (mppx as Record<string, unknown>)['charge'];
  if (typeof chargeAccessor !== 'function') {
    throw new Error(
      'PayMux Server: mppx instance does not expose a .charge() handler. ' +
        'This indicates a breaking change in the mppx package.'
    );
  }

  const factory: ChargeFactory = (opts) => {
    const handler = chargeAccessor(opts);
    if (typeof handler !== 'function') {
      throw new Error(
        'PayMux Server: mppx .charge() did not return a request handler function. ' +
          'This indicates a breaking change in the mppx package.'
      );
    }
    return (request: Request) => handler(request) as Promise<MppChargeResult>;
  };

  // Evict expired entries before inserting to keep cache bounded (H3 fix)
  evictExpiredEntries();

  // Enforce max cache size — evict oldest if full
  if (factoryCache.size >= MAX_FACTORY_CACHE_SIZE) {
    const oldestKey = factoryCache.keys().next().value;
    if (oldestKey !== undefined) {
      factoryCache.delete(oldestKey);
    }
  }

  factoryCache.set(configKey, {
    factory,
    recipient,
    testnet,
    createdAt: Date.now(),
  });
  return factory;
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
  withReceipt?: (response: Response) => Response;
  error?: string;
}> {
  try {
    const charge = await getMppChargeFactory(config);

    // M6 fix: Use toFixed(6) to avoid float precision issues like
    // String(0.1 + 0.2) → "0.30000000000000004"
    const amountStr = Number.isInteger(chargeOpts.amount)
      ? String(chargeOpts.amount)
      : chargeOpts.amount.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

    const result = await charge({
      amount: amountStr,
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
