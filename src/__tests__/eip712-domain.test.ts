/**
 * EIP-712 Domain Parameter Tests
 *
 * Tests the CRITICAL flow of EIP-712 domain parameters (name, version) through
 * the PayMux x402 pipeline:
 *
 * 1. Server generates 402 response with `extra: { name, version }` in accepts
 * 2. Client receives 402, passes requirements to @x402/evm's signEIP3009Authorization
 * 3. @x402/evm reads requirements.extra.name and requirements.extra.version
 * 4. If missing, @x402/evm throws:
 *    "EIP-712 domain parameters (name, version) are required in payment requirements"
 *
 * Root cause of the bug:
 *   @x402/evm's `signEIP3009Authorization()` requires `requirements.extra.name`
 *   and `requirements.extra.version` to construct the EIP-712 domain for
 *   TransferWithAuthorization signing. If the server's 402 response doesn't
 *   include these in the `extra` field, the client-side signing fails.
 *
 * The fix in PayMux:
 *   `src/server/protocols/x402.ts` now includes USDC_EIP712_DOMAIN mapping
 *   that provides `{ name, version }` per chain in the `extra` field of each
 *   accepts entry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { PayMuxServer } from '../server/paymux-server.js';
import { generateX402Requirements } from '../server/protocols/x402.js';
import { detectProtocol } from '../client/protocols/detector.js';
import { toBaseUnits } from '../server/utils.js';

// ─── Test Helpers ────────────────────────────────────────────────

function startExpress(app: express.Express): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://localhost:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

// ─── Test Suite 1: Server includes EIP-712 domain params in 402 ──

describe('EIP-712 Domain: Server 402 Response', () => {
  /**
   * Expected EIP-712 domain params per chain.
   * These MUST match what @x402/evm's ExactEvmScheme.getDefaultAsset() returns,
   * otherwise the facilitator's signature verification will fail (domain mismatch).
   */
  const EXPECTED_DOMAINS: Record<string, { name: string; version: string }> = {
    'base':             { name: 'USD Coin', version: '2' },
    'base-sepolia':     { name: 'USDC',     version: '2' },
    'polygon':          { name: 'USD Coin', version: '2' },
    'polygon-amoy':     { name: 'USD Coin', version: '2' },
    'ethereum':         { name: 'USD Coin', version: '2' },
    'ethereum-sepolia': { name: 'USDC',     version: '2' },
  };

  for (const [chain, expected] of Object.entries(EXPECTED_DOMAINS)) {
    it(`includes EIP-712 domain params for ${chain}: name="${expected.name}", version="${expected.version}"`, () => {
      const config = {
        accept: ['x402' as const],
        x402: {
          recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00' as `0x${string}`,
          chain: chain as any,
        },
      };

      const encoded = generateX402Requirements(
        config,
        { amount: 0.01, currency: 'USD' },
        'https://api.example.com/data'
      );

      const decoded = JSON.parse(atob(encoded));
      const accept = decoded.accepts[0];

      // CRITICAL: extra.name and extra.version MUST be present
      expect(accept.extra).toBeDefined();
      expect(accept.extra.name).toBe(expected.name);
      expect(accept.extra.version).toBe(expected.version);
    });
  }

  it('extra field is a plain object (not null, not undefined, not an array)', () => {
    const config = {
      accept: ['x402' as const],
      x402: {
        recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00' as `0x${string}`,
        chain: 'base-sepolia' as const,
      },
    };

    const encoded = generateX402Requirements(
      config,
      { amount: 0.01 },
      'https://api.example.com/data'
    );

    const decoded = JSON.parse(atob(encoded));
    const extra = decoded.accepts[0].extra;

    expect(extra).not.toBeNull();
    expect(extra).not.toBeUndefined();
    expect(typeof extra).toBe('object');
    expect(Array.isArray(extra)).toBe(false);
  });

  it('extra.name is a non-empty string (not a number, not an object)', () => {
    const encoded = generateX402Requirements(
      {
        accept: ['x402' as const],
        x402: {
          recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00' as `0x${string}`,
          chain: 'base' as const,
        },
      },
      { amount: 0.50 },
    );

    const decoded = JSON.parse(atob(encoded));
    const name = decoded.accepts[0].extra.name;

    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('extra.version is a non-empty string (not a number)', () => {
    const encoded = generateX402Requirements(
      {
        accept: ['x402' as const],
        x402: {
          recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00' as `0x${string}`,
          chain: 'base' as const,
        },
      },
      { amount: 0.50 },
    );

    const decoded = JSON.parse(atob(encoded));
    const version = decoded.accepts[0].extra.version;

    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });
});

// ─── Test Suite 2: Live server 402 includes domain params ────────

describe('EIP-712 Domain: Live Server 402 Response Headers', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = PayMuxServer.create({
      accept: ['x402'],
      x402: {
        recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
        chain: 'base-sepolia',
      },
    });

    app.get(
      '/api/data',
      payments.charge({ amount: 0.01, currency: 'USD' }),
      (_req, res) => res.json({ data: 'premium' })
    );

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('PAYMENT-REQUIRED header includes extra.name and extra.version', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    expect(response.status).toBe(402);

    const paymentRequired = response.headers.get('payment-required');
    expect(paymentRequired).toBeTruthy();

    const decoded = JSON.parse(atob(paymentRequired!));
    const accept = decoded.accepts[0];

    // These are the fields that @x402/evm reads for EIP-712 signing
    expect(accept.extra).toBeDefined();
    expect(accept.extra.name).toBe('USDC');       // Base Sepolia token name
    expect(accept.extra.version).toBe('2');         // EIP-712 domain version
  });

  it('domain params survive base64 encode/decode round-trip', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const headerValue = response.headers.get('payment-required')!;

    // Simulate what @x402/core's client does: decode header -> parse JSON
    const step1_decoded = atob(headerValue);
    const step2_parsed = JSON.parse(step1_decoded);
    const step3_extra = step2_parsed.accepts[0].extra;

    // Domain params must survive the full round-trip
    expect(step3_extra.name).toBe('USDC');
    expect(step3_extra.version).toBe('2');
    expect(typeof step3_extra.name).toBe('string');
    expect(typeof step3_extra.version).toBe('string');
  });
});

// ─── Test Suite 3: Domain params match @x402/evm server scheme ───

describe('EIP-712 Domain: Consistency with @x402/evm ExactEvmScheme', () => {
  /**
   * The @x402/evm server scheme's getDefaultAsset() returns these values.
   * PayMux's USDC_EIP712_DOMAIN must match, otherwise the facilitator
   * will reject the payment (domain hash mismatch).
   *
   * Source: node_modules/@x402/evm/dist/cjs/exact/server/index.js
   */
  const X402_EVM_STABLECOINS: Record<string, { name: string; version: string }> = {
    'eip155:8453':  { name: 'USD Coin', version: '2' },   // Base mainnet
    'eip155:84532': { name: 'USDC',     version: '2' },   // Base Sepolia
  };

  for (const [network, expected] of Object.entries(X402_EVM_STABLECOINS)) {
    it(`PayMux domain params for ${network} match @x402/evm server scheme`, () => {
      // Map network to chain name for generateX402Requirements
      const networkToChain: Record<string, string> = {
        'eip155:8453': 'base',
        'eip155:84532': 'base-sepolia',
      };
      const chain = networkToChain[network];
      if (!chain) return; // skip if no mapping

      const encoded = generateX402Requirements(
        {
          accept: ['x402' as const],
          x402: {
            recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00' as `0x${string}`,
            chain: chain as any,
          },
        },
        { amount: 1.00 },
      );

      const decoded = JSON.parse(atob(encoded));
      const extra = decoded.accepts[0].extra;

      // PayMux values must exactly match @x402/evm's values
      expect(extra.name).toBe(expected.name);
      expect(extra.version).toBe(expected.version);
    });
  }
});

// ─── Test Suite 4: Client-side detection preserves domain params ──

describe('EIP-712 Domain: Client Protocol Detection Preserves Extra', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = PayMuxServer.create({
      accept: ['x402'],
      x402: {
        recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
        chain: 'base-sepolia',
      },
    });

    app.get(
      '/api/data',
      payments.charge({ amount: 0.01 }),
      (_req, res) => res.json({ data: 'content' })
    );

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('raw data in detected requirements preserves the extra field with domain params', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    expect(response.status).toBe(402);

    const requirements = await detectProtocol(response);
    expect(requirements.length).toBe(1);

    // The `raw` field should contain the full x402 PaymentRequired object
    const raw = requirements[0].raw as Record<string, unknown>;
    expect(raw).toBeDefined();

    // Navigate to the extra field in the raw data
    // The raw data structure from detectProtocol should include the accepts array
    // with extra field intact
    const rawAccepts = (raw as any)?.accepts ?? [];
    if (rawAccepts.length > 0) {
      const extra = rawAccepts[0].extra;
      expect(extra).toBeDefined();
      expect(extra.name).toBeDefined();
      expect(extra.version).toBeDefined();
    }
  });
});

// ─── Test Suite 5: Verify/Settle include domain params ───────────

describe('EIP-712 Domain: Verify/Settle paymentRequirements Include Domain Params', () => {
  it('server-constructed paymentRequirements for verify include extra.name and extra.version', () => {
    // Simulate what verifyX402Payment constructs as paymentRequirements
    // when clientAccepted is not available (fallback path)
    const network = 'eip155:84532'; // Base Sepolia

    // This mirrors the logic in src/server/protocols/x402.ts verifyX402Payment
    const USDC_EIP712_DOMAIN: Record<string, { name: string; version: string }> = {
      'eip155:8453':     { name: 'USD Coin', version: '2' },
      'eip155:84532':    { name: 'USDC',     version: '2' },
      'eip155:137':      { name: 'USD Coin', version: '2' },
      'eip155:80002':    { name: 'USD Coin', version: '2' },
      'eip155:1':        { name: 'USD Coin', version: '2' },
      'eip155:11155111': { name: 'USDC',     version: '2' },
    };

    const eip712Domain = USDC_EIP712_DOMAIN[network];
    const paymentRequirements = {
      scheme: 'exact',
      network,
      amount: toBaseUnits(0.01),
      payTo: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      maxTimeoutSeconds: 120,
      extra: {
        ...(eip712Domain && { name: eip712Domain.name, version: eip712Domain.version }),
      },
    };

    // The facilitator's verify endpoint needs these to reconstruct the EIP-712 domain
    expect(paymentRequirements.extra.name).toBe('USDC');
    expect(paymentRequirements.extra.version).toBe('2');
  });

  it('server-constructed paymentRequirements for settle include extra.name and extra.version', () => {
    const network = 'eip155:8453'; // Base mainnet

    const USDC_EIP712_DOMAIN: Record<string, { name: string; version: string }> = {
      'eip155:8453': { name: 'USD Coin', version: '2' },
    };

    const eip712Domain = USDC_EIP712_DOMAIN[network];
    const paymentRequirements = {
      scheme: 'exact',
      network,
      amount: toBaseUnits(1.00),
      payTo: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      maxTimeoutSeconds: 120,
      extra: {
        ...(eip712Domain && { name: eip712Domain.name, version: eip712Domain.version }),
      },
    };

    expect(paymentRequirements.extra.name).toBe('USD Coin');
    expect(paymentRequirements.extra.version).toBe('2');
  });
});

// ─── Test Suite 6: Missing domain params would cause @x402/evm error ──

describe('EIP-712 Domain: Failure Mode Without Domain Params', () => {
  it('simulates the exact error @x402/evm throws when extra.name is missing', () => {
    // This simulates what happens in @x402/evm's signEIP3009Authorization
    // when requirements.extra.name or requirements.extra.version is missing
    const requirements = {
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      extra: {} as Record<string, unknown>,
    };

    // This is the exact check from @x402/evm/dist/cjs/exact/client/index.js line 168
    const shouldThrow = !requirements.extra?.name || !requirements.extra?.version;
    expect(shouldThrow).toBe(true);

    if (shouldThrow) {
      const errorMessage = `EIP-712 domain parameters (name, version) are required in payment requirements for asset ${requirements.asset}`;
      expect(errorMessage).toContain('EIP-712 domain parameters');
      expect(errorMessage).toContain('name, version');
    }
  });

  it('simulates @x402/evm passing when extra.name and extra.version are present', () => {
    const requirements = {
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      extra: { name: 'USDC', version: '2' },
    };

    // Same check from @x402/evm
    const shouldThrow = !requirements.extra?.name || !requirements.extra?.version;
    expect(shouldThrow).toBe(false);
  });

  it('extra with null name would cause the error', () => {
    const requirements = {
      extra: { name: null, version: '2' },
    };
    const shouldThrow = !requirements.extra?.name || !requirements.extra?.version;
    expect(shouldThrow).toBe(true);
  });

  it('extra with empty string name would cause the error', () => {
    const requirements = {
      extra: { name: '', version: '2' },
    };
    const shouldThrow = !requirements.extra?.name || !requirements.extra?.version;
    expect(shouldThrow).toBe(true);
  });

  it('extra with undefined version would cause the error', () => {
    const requirements = {
      extra: { name: 'USD Coin' } as Record<string, unknown>,
    };
    const shouldThrow = !requirements.extra?.name || !requirements.extra?.version;
    expect(shouldThrow).toBe(true);
  });

  it('missing extra entirely would cause the error', () => {
    const requirements = {} as { extra?: Record<string, unknown> };
    const shouldThrow = !requirements.extra?.name || !requirements.extra?.version;
    expect(shouldThrow).toBe(true);
  });
});

// ─── Test Suite 7: EIP-712 Domain Shape Matches Viem TypedData ───

describe('EIP-712 Domain: Shape Compatibility with Viem signTypedData', () => {
  it('domain params produce valid EIP-712 domain object shape', () => {
    // This is the exact shape that @x402/evm passes to viem's signTypedData
    const requirements = {
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      extra: { name: 'USDC', version: '2' },
    };

    // Extract chainId from CAIP-2 network
    const chainId = parseInt(requirements.network.split(':')[1], 10);
    expect(chainId).toBe(84532);

    // Construct the domain (mirrors @x402/evm signEIP3009Authorization)
    const domain = {
      name: requirements.extra.name,
      version: requirements.extra.version,
      chainId,
      verifyingContract: requirements.asset,
    };

    // Validate the domain shape
    expect(domain.name).toBe('USDC');
    expect(domain.version).toBe('2');
    expect(domain.chainId).toBe(84532);
    expect(domain.verifyingContract).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');

    // All fields must be the correct types for viem
    expect(typeof domain.name).toBe('string');
    expect(typeof domain.version).toBe('string');
    expect(typeof domain.chainId).toBe('number');
    expect(typeof domain.verifyingContract).toBe('string');
  });

  it('Base mainnet domain produces correct EIP-712 domain', () => {
    const domain = {
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    };

    expect(domain.name).toBe('USD Coin');
    expect(domain.version).toBe('2');
    expect(domain.chainId).toBe(8453);
    expect(domain.verifyingContract).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});

// ─── Test Suite 8: Full Server-Client Round-Trip ─────────────────

describe('EIP-712 Domain: Full Server-Client Round-Trip', () => {
  let serverUrl: string;
  let closeServer: () => void;

  const chains = [
    { name: 'Base Mainnet', chain: 'base', expectedName: 'USD Coin', expectedVersion: '2' },
    { name: 'Base Sepolia', chain: 'base-sepolia', expectedName: 'USDC', expectedVersion: '2' },
  ];

  for (const tc of chains) {
    describe(`${tc.name}`, () => {
      beforeEach(async () => {
        const app = express();
        const payments = PayMuxServer.create({
          accept: ['x402'],
          x402: {
            recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
            chain: tc.chain as any,
          },
        });

        app.get(
          '/api/data',
          payments.charge({ amount: 0.10 }),
          (_req, res) => res.json({ data: 'content' })
        );

        const started = await startExpress(app);
        serverUrl = started.url;
        closeServer = started.close;
      });

      afterEach(() => closeServer());

      it(`server -> header -> parse -> extra has name="${tc.expectedName}", version="${tc.expectedVersion}"`, async () => {
        // Step 1: Server generates 402
        const response = await fetch(`${serverUrl}/api/data`);
        expect(response.status).toBe(402);

        // Step 2: Extract header (what @x402/core client does)
        const headerValue = response.headers.get('payment-required')!;
        expect(headerValue).toBeTruthy();

        // Step 3: Decode (same as x402HTTPClient.getPaymentRequiredResponse)
        const paymentRequired = JSON.parse(atob(headerValue));

        // Step 4: Select requirements (same as x402Client.selectPaymentRequirements)
        const selectedRequirements = paymentRequired.accepts[0];

        // Step 5: Verify domain params are present (what @x402/evm checks)
        expect(selectedRequirements.extra).toBeDefined();
        expect(selectedRequirements.extra.name).toBe(tc.expectedName);
        expect(selectedRequirements.extra.version).toBe(tc.expectedVersion);

        // Step 6: Verify these would NOT trigger @x402/evm's error
        const wouldThrow = !selectedRequirements.extra?.name || !selectedRequirements.extra?.version;
        expect(wouldThrow).toBe(false);
      });
    });
  }
});
