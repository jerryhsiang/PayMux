import type { PayMuxServerConfig } from '../types.js';
import type { ChargeOptions } from '../../shared/types.js';
import { toBaseUnits } from '../utils.js';

/**
 * USDC contract addresses by chain (CAIP-2 network ID → address).
 * Required by the x402 facilitator — token names like "USDC" won't work.
 */
const USDC_ADDRESSES: Record<string, string> = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
  'eip155:137': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',   // Polygon mainnet
  'eip155:80002': '0x41E94Eb71Ef8C9863E91B9C684D4e1B9F5B1EeA5', // Polygon Amoy
  'eip155:1': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',     // Ethereum mainnet
  'eip155:11155111': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // Ethereum Sepolia
};

const DEFAULT_FACILITATOR = 'https://x402.org/facilitator';

/**
 * Generate x402 payment requirements for a 402 response.
 *
 * Amounts are converted to base units (e.g., 0.01 USD → "10000" for 6-decimal USDC).
 * This matches the x402 v2 spec where maxAmountRequired is in the token's smallest unit.
 */
export function generateX402Requirements(
  config: PayMuxServerConfig,
  chargeOpts: ChargeOptions,
  resource?: string
): string {
  if (!config.x402) {
    throw new Error(
      'PayMux Server: x402 config required. Pass x402: { recipient, chain } to PayMuxServer.create().'
    );
  }

  const chain = config.x402.chain ?? 'base';
  const network = chainToNetwork(chain);
  const asset = config.x402.asset ?? USDC_ADDRESSES[network] ?? USDC_ADDRESSES['eip155:8453'];

  const requirements = {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network,
        maxAmountRequired: toBaseUnits(chargeOpts.amount),
        resource: resource ?? '',
        description: chargeOpts.description ?? '',
        maxTimeoutSeconds: chargeOpts.maxTimeoutSeconds ?? 120,
        payTo: config.x402.recipient,
        asset,
      },
    ],
  };

  return btoa(JSON.stringify(requirements));
}

/**
 * Verify an x402 payment from a request.
 *
 * Parses the PAYMENT-SIGNATURE header and verifies via the facilitator.
 */
export async function verifyX402Payment(
  request: Request,
  config: PayMuxServerConfig,
  chargeOpts: ChargeOptions
): Promise<{ valid: boolean; error?: string }> {
  const paymentHeader = request.headers.get('payment-signature');

  if (!paymentHeader) {
    return { valid: false, error: 'No PAYMENT-SIGNATURE header found' };
  }

  try {
    const payload = JSON.parse(atob(paymentHeader));
    const facilitatorUrl = config.x402?.facilitator ?? DEFAULT_FACILITATOR;
    const network = chainToNetwork(config.x402?.chain ?? 'base');
    const asset = config.x402?.asset ?? USDC_ADDRESSES[network] ?? USDC_ADDRESSES['eip155:8453'];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const verifyResponse = await fetch(`${facilitatorUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: payload,
          paymentRequirements: {
            scheme: 'exact',
            network,
            maxAmountRequired: toBaseUnits(chargeOpts.amount),
            payTo: config.x402?.recipient,
            asset,
            maxTimeoutSeconds: chargeOpts.maxTimeoutSeconds ?? 120,
            resource: '',
            description: chargeOpts.description ?? '',
          },
        }),
      });

      if (!verifyResponse.ok) {
        return {
          valid: false,
          error: `Facilitator verification failed (${verifyResponse.status})`,
        };
      }

      // Real facilitator returns { isValid: boolean } for verify
      const result = (await verifyResponse.json()) as {
        isValid?: boolean;
        success?: boolean;
        valid?: boolean;
      };
      return { valid: result.isValid ?? result.success ?? result.valid ?? false };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    // Handle both DOMException (browser) and Error with name 'AbortError' (Node.js)
    if (error instanceof Error && error.name === 'AbortError') {
      return { valid: false, error: 'Facilitator verification timed out (30s)' };
    }
    return {
      valid: false,
      error: `Payment verification error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Settle an x402 payment on-chain via the facilitator.
 */
export async function settleX402Payment(
  request: Request,
  config: PayMuxServerConfig,
  chargeOpts: ChargeOptions
): Promise<{ settled: boolean; transaction?: string; error?: string }> {
  const paymentHeader = request.headers.get('payment-signature');

  if (!paymentHeader) {
    return { settled: false, error: 'No PAYMENT-SIGNATURE header found' };
  }

  try {
    const payload = JSON.parse(atob(paymentHeader));
    const facilitatorUrl = config.x402?.facilitator ?? DEFAULT_FACILITATOR;
    const network = chainToNetwork(config.x402?.chain ?? 'base');
    const asset = config.x402?.asset ?? USDC_ADDRESSES[network] ?? USDC_ADDRESSES['eip155:8453'];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const settleResponse = await fetch(`${facilitatorUrl}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: payload,
          paymentRequirements: {
            scheme: 'exact',
            network,
            maxAmountRequired: toBaseUnits(chargeOpts.amount),
            payTo: config.x402?.recipient,
            asset,
            maxTimeoutSeconds: chargeOpts.maxTimeoutSeconds ?? 120,
            resource: '',
            description: chargeOpts.description ?? '',
          },
        }),
      });

      if (!settleResponse.ok) {
        return { settled: false, error: `Settlement failed (${settleResponse.status})` };
      }

      const result = (await settleResponse.json()) as {
        success?: boolean;
        settled?: boolean;
        transaction?: string;
        transactionHash?: string;
      };

      // SECURITY: Default to false, not true. Malformed responses should NOT grant access.
      return {
        settled: result.success ?? result.settled ?? false,
        transaction: result.transaction ?? result.transactionHash,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { settled: false, error: 'Settlement timed out (60s)' };
    }
    return {
      settled: false,
      error: `Settlement error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Convert chain shortname to CAIP-2 network identifier.
 */
function chainToNetwork(chain: string): string {
  const networkMap: Record<string, string> = {
    base: 'eip155:8453',
    'base-sepolia': 'eip155:84532',
    polygon: 'eip155:137',
    'polygon-amoy': 'eip155:80002',
    ethereum: 'eip155:1',
    'ethereum-sepolia': 'eip155:11155111',
  };
  return networkMap[chain] ?? chain;
}
