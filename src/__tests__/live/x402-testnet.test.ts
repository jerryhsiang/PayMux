/**
 * Live x402 test — Base Sepolia testnet.
 *
 * This test makes a REAL x402 payment on Base Sepolia using testnet USDC.
 * It's free to run but requires a funded testnet wallet.
 *
 * Setup:
 *   1. Get Base Sepolia USDC from a faucet
 *   2. Set TEST_PRIVATE_KEY in src/__tests__/live/.env
 *   3. Run: npx vitest run src/__tests__/live/x402-testnet.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { config } from 'dotenv';
import path from 'path';
import express from 'express';
import { PayMux } from '../../client/paymux.js';
import { PayMuxServer } from '../../server/paymux-server.js';

// Load .env from the live test directory
config({ path: path.resolve(__dirname, '.env') });

const PRIVATE_KEY = process.env.TEST_PRIVATE_KEY;
const SKIP = !PRIVATE_KEY || PRIVATE_KEY === '0x';

function startExpress(app: express.Express): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://localhost:${addr.port}`, close: () => server.close() });
    });
  });
}

describe.skipIf(SKIP)('Live: x402 on Base Sepolia (testnet)', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeAll(async () => {
    // Start a real PayMux server that accepts x402 payments
    const app = express();
    const payments = PayMuxServer.create({
      accept: ['x402'],
      x402: {
        // Use a known testnet recipient (this is a throwaway address)
        recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        chain: 'base-sepolia',
      },
    });

    app.get('/api/free', (_req, res) => res.json({ free: true }));

    app.get(
      '/api/paid',
      payments.charge({ amount: 0.001, currency: 'USD', description: 'Live test payment' }),
      (_req, res) => res.json({ data: 'live test content', paid: true })
    );

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterAll(() => closeServer?.());

  it('free endpoint works without payment', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: PRIVATE_KEY as `0x${string}` },
      debug: true,
    });

    const response = await agent.fetch(`${serverUrl}/api/free`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.free).toBe(true);
    expect(agent.spending.totalSpent).toBe(0);
  });

  it('paid endpoint returns 402 with valid x402 requirements', async () => {
    const response = await fetch(`${serverUrl}/api/paid`);
    expect(response.status).toBe(402);

    const header = response.headers.get('payment-required');
    expect(header).toBeTruthy();

    const decoded = JSON.parse(atob(header!));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].network).toBe('eip155:84532');
    expect(decoded.accepts[0].asset).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(decoded.accepts[0].maxAmountRequired).toBe('1000'); // 0.001 * 10^6
  });

  it('agent pays x402 endpoint and gets data back', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: PRIVATE_KEY as `0x${string}` },
      limits: { perRequest: 1.00, perDay: 10.00 },
      debug: true,
    });

    const response = await agent.fetch(`${serverUrl}/api/paid`);

    // The payment should succeed and we get the data
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.paid).toBe(true);
    expect(data.data).toBe('live test content');

    // Spending should be tracked
    expect(agent.spending.totalSpent).toBeGreaterThan(0);
    expect(agent.spending.history).toHaveLength(1);
    expect(agent.spending.history[0].protocol).toBe('x402');
  }, 60000); // 60s timeout for blockchain confirmation
});

// Import afterAll at the end to avoid vitest ordering issues
import { afterAll } from 'vitest';
