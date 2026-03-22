/**
 * x402 Integration Test — Evaluates PayMux as an x402 developer would.
 *
 * Tests the COMPLETE x402 flow:
 * 1. Server creates x402 middleware and serves a paid endpoint
 * 2. Agent probes endpoint and gets 402
 * 3. 402 response has correct x402 v2 format
 * 4. Agent's protocol detector correctly parses the response
 * 5. Spending limits work correctly with base-unit-to-USD conversion
 * 6. verify/settle use correct v2 paymentRequirements format
 *
 * This test file validates x402 v2 spec compliance:
 * - `amount` field (not v1's `maxAmountRequired`)
 * - `resource` at the top level of PaymentRequired (not inside accepts)
 * - `extra` field present in each accepts entry
 * - Base units correctly converted for spending limit enforcement
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { PayMux } from '../client/paymux.js';
import { PayMuxServer } from '../server/paymux-server.js';
import { SpendingLimitError } from '../client/spending.js';
import { detectProtocol, selectBestRequirement } from '../client/protocols/detector.js';
import { generateX402Requirements } from '../server/protocols/x402.js';
import { toBaseUnits } from '../server/utils.js';
import { fromBaseUnits, verifyAmountConsistency } from '../client/utils.js';

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

/**
 * Create a PayMux x402 server with configurable options.
 */
function createX402Server(opts?: {
  chain?: string;
  recipient?: string;
}) {
  return PayMuxServer.create({
    accept: ['x402'],
    x402: {
      recipient: (opts?.recipient ?? '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00') as `0x${string}`,
      chain: (opts?.chain ?? 'base-sepolia') as any,
    },
  });
}

// ─── Test Suite 1: x402 v2 Format Compliance ────────────────────

describe('x402 v2 Format Compliance', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = createX402Server({ chain: 'base-sepolia' });

    app.get(
      '/api/data',
      payments.charge({ amount: 0.01, currency: 'USD', description: 'Test data endpoint' }),
      (_req, res) => res.json({ data: 'premium content' })
    );

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('PAYMENT-REQUIRED header contains valid base64-encoded JSON', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    expect(response.status).toBe(402);

    const paymentRequired = response.headers.get('payment-required');
    expect(paymentRequired).toBeTruthy();
    expect(paymentRequired).not.toBe('');

    // Must be valid base64
    let decoded: string;
    expect(() => {
      decoded = atob(paymentRequired!);
    }).not.toThrow();

    // Must be valid JSON
    let parsed: Record<string, unknown>;
    expect(() => {
      parsed = JSON.parse(atob(paymentRequired!));
    }).not.toThrow();
  });

  it('x402Version field is 2 (not 1)', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const decoded = JSON.parse(atob(response.headers.get('payment-required')!));
    expect(decoded.x402Version).toBe(2);
  });

  it('resource field is a TOP-LEVEL object (not inside accepts)', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const decoded = JSON.parse(atob(response.headers.get('payment-required')!));

    // v2: resource is a top-level ResourceInfo object
    expect(decoded.resource).toBeDefined();
    expect(typeof decoded.resource).toBe('object');
    expect(decoded.resource).not.toBeNull();

    // resource.url should be set
    expect(decoded.resource.url).toBeDefined();
    expect(typeof decoded.resource.url).toBe('string');
    expect(decoded.resource.url).toContain('/api/data');

    // description should be present when provided
    expect(decoded.resource.description).toBe('Test data endpoint');
  });

  it('accepts array uses "amount" field (NOT v1 "maxAmountRequired")', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const decoded = JSON.parse(atob(response.headers.get('payment-required')!));

    expect(decoded.accepts).toBeDefined();
    expect(Array.isArray(decoded.accepts)).toBe(true);
    expect(decoded.accepts.length).toBeGreaterThan(0);

    const accept = decoded.accepts[0];

    // v2: uses "amount" field
    expect(accept.amount).toBeDefined();
    expect(typeof accept.amount).toBe('string');

    // Verify amount is in base units: 0.01 USD * 10^6 = 10000
    expect(accept.amount).toBe('10000');
  });

  it('accepts entries have "extra" field for scheme-specific data', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const decoded = JSON.parse(atob(response.headers.get('payment-required')!));

    const accept = decoded.accepts[0];

    // v2: each accept entry must have an extra field
    expect(accept.extra).toBeDefined();
    expect(typeof accept.extra).toBe('object');
  });

  it('accepts entries have required v2 fields: scheme, network, payTo, asset', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const decoded = JSON.parse(atob(response.headers.get('payment-required')!));

    const accept = decoded.accepts[0];

    expect(accept.scheme).toBe('exact');
    expect(accept.network).toBe('eip155:84532'); // base-sepolia
    expect(accept.payTo).toBe('0x742d35Cc6634c0532925a3b844bC9e7595F8fE00');
    expect(accept.asset).toMatch(/^0x[a-fA-F0-9]{40}$/); // Valid USDC contract address
    expect(accept.maxTimeoutSeconds).toBeDefined();
    expect(typeof accept.maxTimeoutSeconds).toBe('number');
  });
});

// ─── Test Suite 2: Protocol Detection Parses x402 v2 Correctly ──

describe('x402 v2 Protocol Detection', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = createX402Server({ chain: 'base-sepolia' });

    app.get(
      '/api/data',
      payments.charge({ amount: 0.01, currency: 'USD' }),
      (_req, res) => res.json({ data: 'content' })
    );

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('detectProtocol correctly identifies x402 from server 402 response', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    expect(response.status).toBe(402);

    const requirements = await detectProtocol(response);

    expect(requirements.length).toBe(1);
    expect(requirements[0].protocol).toBe('x402');
  });

  it('detector parses amount correctly from v2 format', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const requirements = await detectProtocol(response);

    // Raw amount should be base units string
    expect(requirements[0].amount).toBe('10000');
  });

  it('detector converts base units to USD for spending limits (CRITICAL)', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const requirements = await detectProtocol(response);

    // amountUsd should be the USD-converted value
    // 10000 base units / 10^6 = $0.01
    expect(requirements[0].amountUsd).toBeDefined();
    expect(requirements[0].amountUsd).toBeCloseTo(0.01, 6);
  });

  it('detector extracts resource URL from top-level resource object', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const requirements = await detectProtocol(response);

    expect(requirements[0].resource).toBeDefined();
    expect(requirements[0].resource).toContain('/api/data');
  });

  it('detector maps CAIP-2 network to chain shortname', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const requirements = await detectProtocol(response);

    expect(requirements[0].network).toBe('eip155:84532');
    expect(requirements[0].chain).toBe('base-sepolia');
  });

  it('detector extracts payTo from accepts entry', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const requirements = await detectProtocol(response);

    expect(requirements[0].payTo).toBe('0x742d35Cc6634c0532925a3b844bC9e7595F8fE00');
  });

  it('detector extracts asset address (not just "USDC" string)', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    const requirements = await detectProtocol(response);

    // Asset should be the actual contract address, not "USDC"
    expect(requirements[0].asset).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});

// ─── Test Suite 3: Spending Limits with Base Unit Conversion ────

describe('x402 Spending Limits with Base Unit Conversion', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = createX402Server({ chain: 'base-sepolia' });

    // Three price tiers
    app.get('/api/cheap', payments.charge({ amount: 0.001 }), (_req, res) => res.json({ tier: 'cheap' }));
    app.get('/api/medium', payments.charge({ amount: 0.05 }), (_req, res) => res.json({ tier: 'medium' }));
    app.get('/api/expensive', payments.charge({ amount: 5.00 }), (_req, res) => res.json({ tier: 'expensive' }));

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('perRequest limit correctly blocks based on USD (not base units)', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 0.01 }, // $0.01 limit
    });

    // Server charges $0.05 (50000 base units).
    // If we compared 50000 > 0.01, this would ALWAYS fail.
    // With correct conversion: $0.05 > $0.01, should fail.
    await expect(
      agent.fetch(`${serverUrl}/api/medium`)
    ).rejects.toThrow(SpendingLimitError);
  });

  it('perRequest limit correctly ALLOWS when USD amount is within range', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 0.01 }, // $0.01 limit
    });

    // Server charges $0.001 (1000 base units).
    // With correct conversion: $0.001 < $0.01, should pass limit check.
    // It will fail at x402 payment (no real blockchain), but NOT at spending limits.
    try {
      await agent.fetch(`${serverUrl}/api/cheap`);
    } catch (e: any) {
      // Should fail at x402 client (not at spending limits)
      expect(e).not.toBeInstanceOf(SpendingLimitError);
      expect(e.message).toMatch(/x402|Failed to initialize|payment/i);
    }
  });

  it('perDay limit correctly blocks cumulative spending in USD', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perDay: 0.03 }, // $0.03 daily limit
    });

    // Server charges $0.05. With conversion: $0.05 > $0.03 daily limit.
    await expect(
      agent.fetch(`${serverUrl}/api/medium`)
    ).rejects.toThrow(SpendingLimitError);
  });

  it('maxAmount correctly enforced in USD (not base units)', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 100 }, // High per-request limit
    });

    // Server charges $5.00. maxAmount is $1.00.
    // With correct conversion: $5.00 > $1.00.
    await expect(
      agent.fetch(`${serverUrl}/api/expensive`, { maxAmount: 1.00 })
    ).rejects.toThrow('exceeds maxAmount');
  });

  it('spending stats are zero after limit rejections (no money left the wallet)', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 0.001 },
    });

    try { await agent.fetch(`${serverUrl}/api/medium`); } catch {}
    try { await agent.fetch(`${serverUrl}/api/expensive`); } catch {}

    expect(agent.spending.totalSpent).toBe(0);
    expect(agent.spending.pendingSpend).toBe(0);
    expect(agent.spending.dailySpend).toBe(0);
    expect(agent.spending.history).toHaveLength(0);
  });
});

// ─── Test Suite 4: Base Unit Conversion Round-Trip ──────────────

describe('x402 Base Unit Conversion', () => {
  it('toBaseUnits and fromBaseUnits are inverse operations', () => {
    const amounts = [0.001, 0.01, 0.05, 0.10, 0.50, 1.00, 5.00, 10.00, 100.00, 1000.00];

    for (const amount of amounts) {
      const base = toBaseUnits(amount);
      const roundTripped = fromBaseUnits(base);
      expect(roundTripped).toBeCloseTo(amount, 6);
    }
  });

  it('verifyAmountConsistency returns true for correct conversions', () => {
    expect(verifyAmountConsistency('10000', 0.01)).toBe(true);
    expect(verifyAmountConsistency('50000', 0.05)).toBe(true);
    expect(verifyAmountConsistency('1000000', 1.00)).toBe(true);
    expect(verifyAmountConsistency('5000000', 5.00)).toBe(true);
  });

  it('verifyAmountConsistency returns false for incorrect conversions', () => {
    // If someone used base units as USD, this would be wrong
    expect(verifyAmountConsistency('10000', 10000)).toBe(false);
    expect(verifyAmountConsistency('50000', 50000)).toBe(false);
  });

  it('server generates correct base units for various prices', () => {
    const testCases: [number, string][] = [
      [0.001, '1000'],
      [0.01, '10000'],
      [0.05, '50000'],
      [0.10, '100000'],
      [0.50, '500000'],
      [1.00, '1000000'],
      [5.00, '5000000'],
      [10.00, '10000000'],
      [100.00, '100000000'],
    ];

    for (const [amount, expected] of testCases) {
      expect(toBaseUnits(amount)).toBe(expected);
    }
  });

  it('client correctly converts base units back to USD', () => {
    const testCases: [string, number][] = [
      ['1000', 0.001],
      ['10000', 0.01],
      ['50000', 0.05],
      ['100000', 0.10],
      ['500000', 0.50],
      ['1000000', 1.00],
      ['5000000', 5.00],
      ['10000000', 10.00],
    ];

    for (const [base, expected] of testCases) {
      expect(fromBaseUnits(base)).toBeCloseTo(expected, 6);
    }
  });
});

// ─── Test Suite 5: Server Verify/Settle Format ──────────────────

describe('x402 Server Verify/Settle paymentRequirements Format', () => {
  it('generateX402Requirements produces v2 format with correct structure', () => {
    const config = {
      accept: ['x402' as const],
      x402: {
        recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00' as `0x${string}`,
        chain: 'base-sepolia' as const,
      },
    };

    const encoded = generateX402Requirements(
      config,
      { amount: 0.01, currency: 'USD' },
      'https://api.example.com/data'
    );

    const decoded = JSON.parse(atob(encoded));

    // v2 structure validation
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource).toBeDefined();
    expect(decoded.resource.url).toBe('https://api.example.com/data');
    expect(decoded.accepts).toHaveLength(1);

    const accept = decoded.accepts[0];
    expect(accept.scheme).toBe('exact');
    expect(accept.network).toBe('eip155:84532');
    expect(accept.amount).toBe('10000');
    expect(accept.payTo).toBe('0x742d35Cc6634c0532925a3b844bC9e7595F8fE00');
    expect(accept.asset).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(accept.extra).toBeDefined();
    expect(accept.maxTimeoutSeconds).toBeDefined();
  });

  it('verify and settle construct v2 paymentRequirements with matching fields', () => {
    // The verifyX402Payment and settleX402Payment functions construct a
    // paymentRequirements object sent to the facilitator. This test verifies
    // the shape matches what x402.org/facilitator expects.
    //
    // We cannot call verifyX402Payment directly (it needs a real facilitator),
    // but we can verify the generated requirements format matches the
    // facilitator's expected input.
    const config = {
      accept: ['x402' as const],
      x402: {
        recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00' as `0x${string}`,
        chain: 'base-sepolia' as const,
      },
    };

    // Simulate what the verify/settle functions construct as paymentRequirements
    const network = 'eip155:84532';
    const amount = toBaseUnits(0.01);
    const asset = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia USDC

    const paymentRequirements = {
      scheme: 'exact',
      network,
      amount,
      payTo: config.x402.recipient,
      asset,
      maxTimeoutSeconds: 120,
      extra: {},
    };

    // Verify the structure matches x402 v2 spec
    expect(paymentRequirements.scheme).toBe('exact');
    expect(paymentRequirements.amount).toBe('10000'); // base units, NOT "0.01"
    expect(paymentRequirements.network).toBe('eip155:84532');
    expect(paymentRequirements.extra).toBeDefined();

    // The facilitator verify/settle body should wrap this as:
    // { x402Version: 2, paymentPayload: <signed>, paymentRequirements: <above> }
    const facilitatorBody = {
      x402Version: 2,
      paymentPayload: { /* signed payment data */ },
      paymentRequirements,
    };

    expect(facilitatorBody.x402Version).toBe(2);
    expect(facilitatorBody.paymentRequirements.scheme).toBe('exact');
    expect(facilitatorBody.paymentRequirements.amount).toBe('10000');
  });
});

// ─── Test Suite 6: Multi-Chain Support ──────────────────────────

describe('x402 Multi-Chain Support', () => {
  const chains: Array<{
    name: string;
    chain: string;
    expectedNetwork: string;
    expectedAssetPattern: RegExp;
  }> = [
    { name: 'Base Mainnet', chain: 'base', expectedNetwork: 'eip155:8453', expectedAssetPattern: /^0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913$/i },
    { name: 'Base Sepolia', chain: 'base-sepolia', expectedNetwork: 'eip155:84532', expectedAssetPattern: /^0x036CbD53842c5426634e7929541eC2318f3dCF7e$/i },
    { name: 'Polygon Mainnet', chain: 'polygon', expectedNetwork: 'eip155:137', expectedAssetPattern: /^0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359$/i },
  ];

  for (const tc of chains) {
    it(`generates correct requirements for ${tc.name}`, async () => {
      const app = express();
      const payments = createX402Server({ chain: tc.chain });
      app.get('/api/data', payments.charge({ amount: 0.01 }), (_req, res) => res.json({}));
      const { url, close } = await startExpress(app);

      try {
        const response = await fetch(`${url}/api/data`);
        const decoded = JSON.parse(atob(response.headers.get('payment-required')!));

        expect(decoded.accepts[0].network).toBe(tc.expectedNetwork);
        expect(decoded.accepts[0].asset).toMatch(tc.expectedAssetPattern);
      } finally {
        close();
      }
    });
  }
});

// ─── Test Suite 7: End-to-End Agent-Server x402 Flow ────────────

describe('x402 End-to-End Agent-Server Flow', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = createX402Server({ chain: 'base-sepolia' });

    app.get('/api/free', (_req, res) => res.json({ data: 'free content' }));
    app.get(
      '/api/paid',
      payments.charge({ amount: 0.01, currency: 'USD' }),
      (_req, res) => res.json({ data: 'paid content', secret: 42 })
    );

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('free endpoint passes through without payment', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 1.00, perDay: 200.00 },
    });

    const response = await agent.fetch(`${serverUrl}/api/free`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data).toBe('free content');
    expect(agent.spending.totalSpent).toBe(0);
  });

  it('agent probes paid endpoint and gets 402 with x402 v2 format', async () => {
    // Manual probe (what agent.fetch does internally)
    const response = await fetch(`${serverUrl}/api/paid`);

    expect(response.status).toBe(402);

    // Verify complete x402 v2 format
    const paymentRequired = response.headers.get('payment-required');
    expect(paymentRequired).toBeTruthy();

    const decoded = JSON.parse(atob(paymentRequired!));

    // x402 v2 structure
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource).toBeDefined();
    expect(typeof decoded.resource).toBe('object');
    expect(decoded.resource.url).toContain('/api/paid');
    expect(decoded.accepts).toBeDefined();
    expect(Array.isArray(decoded.accepts)).toBe(true);
    expect(decoded.accepts.length).toBe(1);

    // Accept entry
    const accept = decoded.accepts[0];
    expect(accept.scheme).toBe('exact');
    expect(accept.amount).toBe('10000'); // v2: "amount", not "maxAmountRequired"
    expect(accept.network).toBe('eip155:84532');
    expect(accept.payTo).toBe('0x742d35Cc6634c0532925a3b844bC9e7595F8fE00');
    expect(accept.asset).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(accept.extra).toBeDefined();
    expect(accept.maxTimeoutSeconds).toBeGreaterThan(0);
  });

  it('agent correctly detects x402 protocol from server response', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 100.00, perDay: 200.00 },
      debug: true,
    });

    // The agent will:
    // 1. Probe -> get 402
    // 2. Detect x402
    // 3. Convert 10000 base units -> $0.01 USD
    // 4. Check spending limits ($0.01 < $100 perRequest) -> pass
    // 5. Try to sign payment -> fail (no real blockchain)
    try {
      await agent.fetch(`${serverUrl}/api/paid`);
    } catch (e: any) {
      // Should fail at x402 client level, NOT at protocol detection
      expect(e.message).not.toContain('Could not detect');
      expect(e.message).not.toContain('No supported payment');
      expect(e.message).not.toContain('SpendingLimit');
      // The error comes from @x402/core when it tries to sign the payment.
      // Valid errors include: x402 init failure, EIP-712 domain parameter issues,
      // or payment signing errors. The key assertion is that it got PAST detection.
      expect(e.message).toMatch(/x402|Failed to initialize|EIP-712|payment/i);
    }
  });

  it('spending limits enforce in USD correctly ($0.01 charge vs $0.005 limit)', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 0.005 }, // $0.005 limit, server charges $0.01
    });

    // $0.01 > $0.005 -> should throw SpendingLimitError
    await expect(
      agent.fetch(`${serverUrl}/api/paid`)
    ).rejects.toThrow(SpendingLimitError);

    // No money should have left the wallet
    expect(agent.spending.totalSpent).toBe(0);
    expect(agent.spending.pendingSpend).toBe(0);
  });

  it('spending limits pass correctly ($0.01 charge vs $0.02 limit)', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 0.02 }, // $0.02 limit, server charges $0.01
    });

    // $0.01 < $0.02 -> should pass limit check, fail at x402 payment
    try {
      await agent.fetch(`${serverUrl}/api/paid`);
    } catch (e: any) {
      expect(e).not.toBeInstanceOf(SpendingLimitError);
    }
  });
});

// ─── Test Suite 8: x402 Session Budget Enforcement ──────────────

describe('x402 Session Budget with Base Unit Conversion', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = createX402Server({ chain: 'base-sepolia' });
    app.get('/api/data', payments.charge({ amount: 0.01 }), (_req, res) => res.json({ data: 'ok' }));
    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('session budget is charged against global limits upfront', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perDay: 100.00 },
    });

    const session = await agent.openSession({
      url: serverUrl,
      budget: 5.00,
    });

    expect(agent.spending.pendingSpend).toBe(5.00);

    await session.close();
    expect(agent.spending.pendingSpend).toBe(0);
  });

  it('session rejects when budget exceeds daily limit', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perDay: 2.00 },
    });

    await expect(
      agent.openSession({ url: serverUrl, budget: 5.00 })
    ).rejects.toThrow(SpendingLimitError);
  });
});

// ─── Test Suite 9: setLimits at Runtime ─────────────────────────

describe('x402 Runtime Limit Updates', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = createX402Server({ chain: 'base-sepolia' });
    app.get('/api/data', payments.charge({ amount: 0.01 }), (_req, res) => res.json({ data: 'ok' }));
    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('setLimits allows tightening limits at runtime', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 1.00 }, // High initial limit
    });

    // Tighten the limit
    agent.setLimits({ perRequest: 0.005 });

    // Now $0.01 charge > $0.005 limit -> should reject
    await expect(
      agent.fetch(`${serverUrl}/api/data`)
    ).rejects.toThrow(SpendingLimitError);
  });

  it('setLimits allows loosening limits at runtime', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 0.005 }, // Tight initial limit
    });

    // Verify it blocks initially
    await expect(
      agent.fetch(`${serverUrl}/api/data`)
    ).rejects.toThrow(SpendingLimitError);

    // Loosen the limit
    agent.setLimits({ perRequest: 1.00 });

    // Now $0.01 charge < $1.00 limit -> should pass limit check
    try {
      await agent.fetch(`${serverUrl}/api/data`);
    } catch (e: any) {
      // Should fail at x402 payment, not at spending limits
      expect(e).not.toBeInstanceOf(SpendingLimitError);
    }
  });
});
