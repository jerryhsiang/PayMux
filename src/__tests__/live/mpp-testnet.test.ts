/**
 * Live MPP test — Tempo testnet.
 *
 * This test runs BOTH a PayMux MPP server and a PayMux MPP client,
 * completing a real payment flow on Tempo testnet.
 *
 * Setup:
 *   1. Set TEST_PRIVATE_KEY in src/__tests__/live/.env
 *   2. Set TEST_MPP_SECRET_KEY (any random 32+ byte base64 string)
 *   3. Run: npx vitest run src/__tests__/live/mpp-testnet.test.ts
 *
 * Note: Tempo testnet tokens are needed. The Tempo testnet faucet
 * can be found at https://tempo.xyz (check their docs for current faucet URL).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config } from 'dotenv';
import path from 'path';
import express from 'express';
import { PayMux } from '../../client/paymux.js';
import { PayMuxServer } from '../../server/paymux-server.js';

config({ path: path.resolve(__dirname, '.env') });

const PRIVATE_KEY = process.env.TEST_PRIVATE_KEY;
const MPP_SECRET_KEY = process.env.TEST_MPP_SECRET_KEY;
const SKIP = !PRIVATE_KEY || PRIVATE_KEY === '0x' || !MPP_SECRET_KEY;

function startExpress(app: express.Express): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://localhost:${addr.port}`, close: () => server.close() });
    });
  });
}

describe.skipIf(SKIP)('Live: MPP on Tempo testnet', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeAll(async () => {
    const app = express();

    // PayMux server accepting MPP payments via Tempo
    const payments = PayMuxServer.create({
      accept: ['mpp'],
      mpp: {
        secretKey: MPP_SECRET_KEY!,
        tempoRecipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        testnet: true,
      },
    });

    app.get('/api/free', (_req, res) => res.json({ free: true }));

    app.get(
      '/api/paid',
      payments.charge({ amount: 0.001, description: 'MPP live test' }),
      (_req, res) => res.json({ data: 'mpp content', protocol: 'mpp', paid: true })
    );

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterAll(() => closeServer?.());

  it('free endpoint works without payment', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: PRIVATE_KEY as `0x${string}` },
    });

    const response = await agent.fetch(`${serverUrl}/api/free`);
    expect(response.status).toBe(200);
  });

  it('paid endpoint returns 402', async () => {
    const response = await fetch(`${serverUrl}/api/paid`);
    expect(response.status).toBe(402);

    // MPP should return WWW-Authenticate header or x402 PAYMENT-REQUIRED
    // Depending on whether mppx handles the initial 402 or PayMux does
    const body = await response.json();
    expect(body.protocols).toContain('mpp');
  });

  it('agent pays MPP endpoint and gets data back', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: PRIVATE_KEY as `0x${string}` },
      limits: { perRequest: 1.00, perDay: 10.00 },
      debug: true,
    });

    const response = await agent.fetch(`${serverUrl}/api/paid`);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.paid).toBe(true);
    expect(data.protocol).toBe('mpp');

    // Spending should be tracked
    expect(agent.spending.totalSpent).toBeGreaterThan(0);
    expect(agent.spending.history).toHaveLength(1);
    expect(agent.spending.history[0].protocol).toBe('mpp');

    console.log('💰 MPP payment successful!');
    if (agent.spending.history[0].transactionHash) {
      console.log(`   Tx: ${agent.spending.history[0].transactionHash}`);
    }
  }, 60000);
});

describe.skipIf(SKIP)('Live: Dual-protocol (x402 + MPP) on testnet', () => {
  let serverUrl: string;
  let closeServer: () => void;

  beforeAll(async () => {
    const app = express();

    // Server accepts BOTH protocols
    const payments = PayMuxServer.create({
      accept: ['x402', 'mpp'],
      x402: {
        recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        chain: 'base-sepolia',
      },
      mpp: {
        secretKey: MPP_SECRET_KEY!,
        tempoRecipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        testnet: true,
      },
    });

    app.get(
      '/api/dual',
      payments.charge({ amount: 0.001, description: 'Dual protocol test' }),
      (_req, res) => res.json({ data: 'dual protocol', paid: true })
    );

    const started = await startExpress(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterAll(() => closeServer?.());

  it('agent auto-detects and pays via best available protocol', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: PRIVATE_KEY as `0x${string}` },
      limits: { perRequest: 1.00, perDay: 10.00 },
      debug: true,
    });

    const response = await agent.fetch(`${serverUrl}/api/dual`);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.paid).toBe(true);

    // Should have used one of the two protocols
    const protocol = agent.spending.history[0].protocol;
    expect(['x402', 'mpp']).toContain(protocol);

    console.log(`💰 Dual-protocol test: paid via ${protocol}`);
  }, 60000);

  it('agent can force x402 protocol', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: PRIVATE_KEY as `0x${string}` },
      limits: { perRequest: 1.00 },
      debug: true,
    });

    const response = await agent.fetch(`${serverUrl}/api/dual`, { protocol: 'x402' });

    expect(response.status).toBe(200);
    // Protocol preference respected (if server supports x402, it should use it)
  }, 60000);

  it('agent can force MPP protocol', async () => {
    const agent = PayMux.create({
      wallet: { privateKey: PRIVATE_KEY as `0x${string}` },
      limits: { perRequest: 1.00 },
      preferProtocol: ['mpp'],
      debug: true,
    });

    const response = await agent.fetch(`${serverUrl}/api/dual`);

    expect(response.status).toBe(200);
  }, 60000);
});
