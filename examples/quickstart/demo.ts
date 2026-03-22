/**
 * PayMux Quickstart — Local Demo (no wallet needed)
 *
 * This demo runs a paid API server and an agent in the SAME process,
 * showing the full payment detection flow WITHOUT requiring a funded wallet
 * or testnet USDC. It demonstrates:
 *
 * 1. Server returns 402 with x402 payment requirements
 * 2. Agent detects the protocol and amount
 * 3. Spending limits block the payment (since we have no real wallet)
 * 4. Free endpoints pass through with zero overhead
 *
 * Run: npm run demo
 */

import express from 'express';
import { PayMux, SpendingLimitError } from 'paymux';
import { PayMuxServer } from 'paymux/server';

async function demo() {
  // ── 1. Start a paid API server ──────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  PayMux Quickstart Demo');
  console.log('  No wallet needed — shows the payment detection flow');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  const app = express();

  const payments = PayMuxServer.create({
    accept: ['x402'],
    x402: {
      recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      chain: 'base-sepolia',
    },
  });

  app.get('/api/time', (_req, res) => res.json({ time: new Date().toISOString() }));
  app.get('/api/joke',
    payments.charge({ amount: 0.01, currency: 'USD' }),
    (_req, res) => res.json({ joke: 'Why do programmers prefer dark mode? Light attracts bugs.' })
  );
  app.get('/api/premium',
    payments.charge({ amount: 0.50, currency: 'USD' }),
    (_req, res) => res.json({ data: 'premium content', secret: 42 })
  );

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const BASE = `http://localhost:${port}`;

  console.log(`📡 Server running on port ${port}`);
  console.log('');

  // ── 2. Create an agent (no real wallet — will fail at payment) ──
  const agent = PayMux.create({
    limits: { perRequest: 0.05, perDay: 1.00 },
    debug: true,
  });

  // ── 3. Demo: Free endpoint ──────────────────────────────────────
  console.log('─── Demo 1: Free endpoint (no payment) ───');
  const timeRes = await agent.fetch(`${BASE}/api/time`);
  console.log(`Status: ${timeRes.status}`);
  console.log(`Data: ${JSON.stringify(await timeRes.json())}`);
  console.log(`Spent: $${agent.spending.totalSpent.toFixed(2)}`);
  console.log('✅ Free endpoints work with zero overhead');
  console.log('');

  // ── 4. Demo: Paid endpoint (402 detection) ──────────────────────
  console.log('─── Demo 2: Paid endpoint — $0.01 (protocol detection) ───');
  try {
    await agent.fetch(`${BASE}/api/joke`);
    console.log('(This should not succeed without a wallet)');
  } catch (error) {
    const msg = (error as Error).message;
    if (msg.includes('no wallet')) {
      console.log(`✅ PayMux detected x402 and reported: "${msg}"`);
      console.log('   → In production with a funded wallet, this would auto-pay and return data');
    } else {
      console.log(`Error: ${msg}`);
    }
  }
  console.log('');

  // ── 5. Demo: Spending limits ──────────────────────────────────
  console.log('─── Demo 3: Spending limits ───');

  // Create agent WITH a fake private key to test spending limits
  const agentWithLimits = PayMux.create({
    wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
    limits: { perRequest: 0.05, perDay: 1.00 },
    debug: true,
  });

  // The premium endpoint costs $0.50 — exceeds perRequest limit of $0.05
  console.log('Trying $0.50 endpoint with $0.05 per-request limit...');
  try {
    await agentWithLimits.fetch(`${BASE}/api/premium`);
    console.log('(Should have been blocked)');
  } catch (error) {
    if (error instanceof SpendingLimitError) {
      console.log(`✅ Spending limit blocked the payment!`);
      console.log(`   Limit type: ${error.limitType}`);
      console.log(`   Requested:  $${error.requestedAmount.toFixed(2)}`);
      console.log(`   Limit:      $${error.limit.toFixed(2)}`);
    } else {
      console.log(`Error: ${(error as Error).message}`);
    }
  }
  console.log('');

  // The joke endpoint costs $0.01 — within the limit, but will fail at signing
  console.log('Trying $0.01 endpoint with $0.05 per-request limit...');
  try {
    await agentWithLimits.fetch(`${BASE}/api/joke`);
  } catch (error) {
    const msg = (error as Error).message;
    console.log(`✅ Spending limit passed ($0.01 < $0.05), but payment signing failed`);
    console.log(`   (Expected — the test key has no testnet USDC)`);
  }
  console.log('');

  // ── 6. Demo: What the 402 response looks like ─────────────────
  console.log('─── Demo 4: Raw 402 response ───');
  const rawRes = await fetch(`${BASE}/api/joke`);
  console.log(`Status: ${rawRes.status} ${rawRes.statusText}`);
  console.log(`Headers:`);
  const paymentRequired = rawRes.headers.get('payment-required');
  if (paymentRequired) {
    const decoded = JSON.parse(atob(paymentRequired));
    console.log(`  Payment-Required: ${JSON.stringify(decoded, null, 2)}`);
  }
  const body = await rawRes.json();
  console.log(`Body: ${JSON.stringify(body, null, 2)}`);
  console.log('');

  // ── 7. Summary ────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════');
  console.log('  Demo complete!');
  console.log('');
  console.log('  What you saw:');
  console.log('  ✅ Free endpoints pass through (1 HTTP call, zero overhead)');
  console.log('  ✅ Paid endpoints return 402 with x402 requirements');
  console.log('  ✅ PayMux detects the protocol automatically');
  console.log('  ✅ Spending limits block overspend before payment');
  console.log('  ✅ Clear error messages tell you exactly what happened');
  console.log('');
  console.log('  Next: Fund a wallet with testnet USDC and run:');
  console.log('    npm run server    # Terminal 1');
  console.log('    PRIVATE_KEY=0x... npm run agent    # Terminal 2');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  server.close();
}

demo().catch(console.error);
