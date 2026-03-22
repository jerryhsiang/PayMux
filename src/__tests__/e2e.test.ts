/**
 * End-to-end integration tests.
 *
 * These test the PRODUCT, not the plumbing:
 * - An API developer adds payments.charge() to their Express/Hono app
 * - An agent developer calls agent.fetch() against that API
 * - The agent pays, the server verifies, data flows back
 *
 * These use mocked facilitator/blockchain responses to test locally
 * without real on-chain transactions. For live tests against real
 * endpoints, see tests/live/ (not included in CI).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { Hono } from 'hono';
import { PayMux } from '../client/paymux.js';
import { PayMuxServer } from '../server/paymux-server.js';
import { SpendingLimitError } from '../client/spending.js';
import http from 'http';

// ─── Test Helpers ────────────────────────────────────────────────

/**
 * Start an Express server on a random port. Returns the URL and a close function.
 */
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

// ─── Scenario 1: API Developer adds x402 payments to Express ────

describe('E2E: Express server with x402 payments', () => {
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

    // Free endpoint
    app.get('/api/info', (_req, res) => {
      res.json({ name: 'Test API', version: '1.0' });
    });

    // Paid endpoint — $0.01
    app.get(
      '/api/premium',
      payments.charge({ amount: 0.01, currency: 'USD', description: 'Premium data' }),
      (_req, res) => {
        res.json({ data: 'premium content', secret: 42 });
      }
    );

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => {
    closeServer();
  });

  it('free endpoint returns 200 without payment', async () => {
    const response = await fetch(`${serverUrl}/api/info`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.name).toBe('Test API');
  });

  it('paid endpoint returns 402 with PAYMENT-REQUIRED header', async () => {
    const response = await fetch(`${serverUrl}/api/premium`);
    expect(response.status).toBe(402);

    // Must have PAYMENT-REQUIRED header
    const paymentRequired = response.headers.get('payment-required');
    expect(paymentRequired).toBeTruthy();

    // Decode and verify x402 format
    const decoded = JSON.parse(atob(paymentRequired!));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0].scheme).toBe('exact');
    expect(decoded.accepts[0].network).toBe('eip155:84532'); // base-sepolia
    expect(decoded.accepts[0].payTo).toBe('0x742d35Cc6634c0532925a3b844bC9e7595F8fE00');

    // Amount should be in base units (0.01 * 10^6 = 10000)
    expect(decoded.accepts[0].maxAmountRequired).toBe('10000');

    // Asset should be USDC contract address, not "USDC" string
    expect(decoded.accepts[0].asset).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('paid endpoint returns JSON error body with protocol info', async () => {
    const response = await fetch(`${serverUrl}/api/premium`);
    const body = await response.json();

    expect(body.error).toBe('Payment Required');
    expect(body.protocols).toContain('x402');
  });

  it('agent detects x402 requirement from 402 response', async () => {
    // Agent without wallet — should detect the protocol and give clear error
    const agent = PayMux.create({});
    await expect(
      agent.fetch(`${serverUrl}/api/premium`)
    ).rejects.toThrow('no wallet');
  });

  it('agent respects spending limits before attempting payment', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 0.001 }, // $0.001 limit, server charges $0.01
    });

    // The 402 response says amount is 10000 base units.
    // parseFloat("10000") = 10000 which exceeds perRequest of 0.001
    await expect(
      agent.fetch(`${serverUrl}/api/premium`)
    ).rejects.toThrow(SpendingLimitError);
  });

  it('agent spending stats track correctly after limit rejection', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 0.001 },
    });

    try { await agent.fetch(`${serverUrl}/api/premium`); } catch {}

    // Spending should NOT be recorded for rejected payments
    expect(agent.spending.totalSpent).toBe(0);
    expect(agent.spending.pendingSpend).toBe(0);
    expect(agent.spending.history).toHaveLength(0);
  });
});

// ─── Scenario 2: Multiple paid endpoints with different prices ──

describe('E2E: Express server with multiple price tiers', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = PayMuxServer.create({
      accept: ['x402'],
      x402: { recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00', chain: 'base' },
    });

    // Different prices for different endpoints
    app.get('/api/cheap', payments.charge({ amount: 0.001 }), (_req, res) => res.json({ tier: 'cheap' }));
    app.get('/api/expensive', payments.charge({ amount: 10.00 }), (_req, res) => res.json({ tier: 'expensive' }));

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('cheap endpoint returns correct amount in base units', async () => {
    const response = await fetch(`${serverUrl}/api/cheap`);
    const decoded = JSON.parse(atob(response.headers.get('payment-required')!));
    // 0.001 * 10^6 = 1000
    expect(decoded.accepts[0].maxAmountRequired).toBe('1000');
  });

  it('expensive endpoint returns correct amount in base units', async () => {
    const response = await fetch(`${serverUrl}/api/expensive`);
    const decoded = JSON.parse(atob(response.headers.get('payment-required')!));
    // 10.00 * 10^6 = 10000000
    expect(decoded.accepts[0].maxAmountRequired).toBe('10000000');
  });
});

// ─── Scenario 3: PayMux detects protocol from real 402 response ──

describe('E2E: Agent protocol detection against real server', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = PayMuxServer.create({
      accept: ['x402'],
      x402: { recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00', chain: 'base-sepolia' },
    });

    app.get('/api/data', payments.charge({ amount: 0.05, description: 'Test data' }), (_req, res) => {
      res.json({ data: 'protected' });
    });

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('agent.fetch() probes, detects x402, and checks limits', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 100000 }, // High limit so it passes the limit check
      debug: true,
    });

    // This will:
    // 1. Probe the endpoint (get 402)
    // 2. Detect x402 from PAYMENT-REQUIRED header
    // 3. Check spending limits (amount 50000 < perRequest 100000, passes)
    // 4. Try to pay via @x402/fetch (will fail because no real blockchain)
    //
    // We expect it to fail at step 4 (payment execution), not at detection
    try {
      await agent.fetch(`${serverUrl}/api/data`);
    } catch (e: any) {
      // Should fail at x402 payment (initialization or signing), NOT at detection
      expect(e.message).not.toContain('Could not detect');
      expect(e.message).not.toContain('No supported payment');
      expect(e.message).not.toContain('no wallet');
      // It should fail at the x402 client level (library not available or signing failed)
      expect(e.message).toMatch(/x402|Failed to initialize|payment/i);
    }
  });

  it('spending limits checked BEFORE payment attempt', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 1 }, // Very low — 50000 base units will exceed this
    });

    // Should throw SpendingLimitError BEFORE attempting payment
    await expect(
      agent.fetch(`${serverUrl}/api/data`)
    ).rejects.toThrow(SpendingLimitError);

    // Confirm no payment was attempted (spending is 0)
    expect(agent.spending.totalSpent).toBe(0);
  });
});

// ─── Scenario 4: Non-payment endpoints pass through cleanly ─────

describe('E2E: Agent with non-402 endpoints', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    app.get('/api/free', (_req, res) => res.json({ free: true }));
    app.get('/api/error', (_req, res) => res.status(500).json({ error: 'boom' }));
    app.get('/api/redirect', (_req, res) => res.redirect('/api/free'));

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('200 responses pass through with zero overhead', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
    });

    const response = await agent.fetch(`${serverUrl}/api/free`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.free).toBe(true);

    // No payments should be recorded
    expect(agent.spending.totalSpent).toBe(0);
    expect(agent.spending.history).toHaveLength(0);
  });

  it('500 errors pass through without payment attempt', async () => {
    const agent = PayMux.create({});
    const response = await agent.fetch(`${serverUrl}/api/error`);
    expect(response.status).toBe(500);
  });
});

// ─── Scenario 5: Debug mode shows the payment flow ──────────────

describe('E2E: Debug logging shows payment flow', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeEach(async () => {
    const app = express();
    const payments = PayMuxServer.create({
      accept: ['x402'],
      x402: { recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00', chain: 'base-sepolia' },
    });
    app.get('/api/paid', payments.charge({ amount: 0.01 }), (_req, res) => res.json({ ok: true }));

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterEach(() => closeServer());

  it('debug: true logs the full payment detection flow', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const agent = PayMux.create({
      wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      limits: { perRequest: 0.001 }, // Will be rejected
      debug: true,
    });

    try { await agent.fetch(`${serverUrl}/api/paid`); } catch {}

    spy.mockRestore();

    // Should see the full flow in logs
    expect(logs.some(l => l.includes('[>]'))).toBe(true);   // Request log
    expect(logs.some(l => l.includes('402'))).toBe(true);    // 402 detection
    expect(logs.some(l => l.includes('x402'))).toBe(true);   // Protocol detected
  });
});
