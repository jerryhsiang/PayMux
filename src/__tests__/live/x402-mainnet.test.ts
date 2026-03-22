/**
 * Live x402 test — Base MAINNET.
 *
 * ⚠️  THIS TEST SPENDS REAL MONEY. Each run costs ~$0.001-0.01 in USDC on Base.
 *
 * Setup:
 *   1. Send USDC to your wallet on Base mainnet
 *   2. Set TEST_PRIVATE_KEY in src/__tests__/live/.env
 *   3. Run: npx vitest run src/__tests__/live/x402-mainnet.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config } from 'dotenv';
import path from 'path';
import express from 'express';
import { PayMux } from '../../client/paymux.js';
import { PayMuxServer } from '../../server/paymux-server.js';

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

describe.skipIf(SKIP)('Live: x402 on Base MAINNET (costs real USDC)', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeAll(async () => {
    const app = express();
    const payments = PayMuxServer.create({
      accept: ['x402'],
      x402: {
        recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        chain: 'base', // MAINNET
      },
    });

    app.get(
      '/api/data',
      payments.charge({ amount: 0.001, currency: 'USD', description: 'Mainnet live test' }),
      (_req, res) => res.json({ data: 'mainnet content', chain: 'base', paid: true })
    );

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterAll(() => closeServer?.());

  it('402 response uses Base mainnet network ID and USDC address', async () => {
    const response = await fetch(`${serverUrl}/api/data`);
    expect(response.status).toBe(402);

    const decoded = JSON.parse(atob(response.headers.get('payment-required')!));
    expect(decoded.accepts[0].network).toBe('eip155:8453'); // Base mainnet
    // Mainnet USDC contract address
    expect(decoded.accepts[0].asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });

  it('agent pays with real USDC on Base mainnet', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: PRIVATE_KEY as `0x${string}` },
      limits: { perRequest: 0.01, perDay: 1.00 },
      debug: true,
    });

    const response = await agent.fetch(`${serverUrl}/api/data`);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.paid).toBe(true);
    expect(data.chain).toBe('base');

    // Verify spending was tracked
    expect(agent.spending.totalSpent).toBeGreaterThan(0);
    expect(agent.spending.history[0].protocol).toBe('x402');
    expect(agent.spending.history[0].transactionHash).toBeTruthy();

    console.log('💰 Mainnet payment successful!');
    console.log(`   Tx: ${agent.spending.history[0].transactionHash}`);
    console.log(`   Amount: ${agent.spending.history[0].amount} ${agent.spending.history[0].currency}`);
  }, 120000); // 2 min timeout for mainnet confirmation
});
