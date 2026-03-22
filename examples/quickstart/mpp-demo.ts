/**
 * PayMux MPP Demo — See the MPP payment flow (no wallet needed)
 *
 * This demo runs a paid API server and an agent in the SAME process,
 * showing the full MPP (Micropayments Protocol) detection flow WITHOUT
 * requiring a funded Tempo wallet or the mppx library. It demonstrates:
 *
 * 1. Server returns 402 with MPP WWW-Authenticate: Payment challenge
 * 2. Agent detects the protocol and extracts the amount
 * 3. Spending limits are enforced before any payment attempt
 * 4. What a successful MPP flow looks like (explained step by step)
 *
 * Run: npm run mpp-demo
 */

import express from 'express';
import { PayMux, SpendingLimitError } from 'paymux';

// ── Helpers: Build realistic MPP challenge headers ───────────────────
// In production, mppx generates these. For this demo we construct them
// manually so you can see exactly what the protocol looks like.

function base64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build a realistic MPP WWW-Authenticate: Payment challenge header.
 *
 * This matches the format that mppx/server generates:
 *   Payment id="<uuid>", realm="<realm>", method="tempo", intent="charge",
 *     request="<base64url-encoded JSON>"
 *
 * The `request` field contains the actual payment details (amount, currency,
 * recipient, description) encoded as base64url JSON.
 */
function buildMppChallenge(opts: {
  amount: number;
  currency: string;
  recipient: string;
  description?: string;
  realm?: string;
}): string {
  const challengeId = crypto.randomUUID();

  const requestPayload = base64urlEncode(JSON.stringify({
    amount: String(opts.amount),
    currency: opts.currency,
    recipient: opts.recipient,
    description: opts.description ?? '',
  }));

  return (
    `Payment id="${challengeId}", ` +
    `realm="${opts.realm ?? 'paymux-demo'}", ` +
    `method="tempo", ` +
    `intent="charge", ` +
    `request="${requestPayload}"`
  );
}

// ── Main Demo ────────────────────────────────────────────────────────

async function demo() {
  console.log('');
  console.log('=======================================================');
  console.log('  PayMux MPP Demo');
  console.log('  Micropayments Protocol (Stripe/Tempo) Detection Flow');
  console.log('  No wallet needed — shows protocol detection + headers');
  console.log('=======================================================');
  console.log('');

  // ── 1. Start a server that returns MPP 402 challenges ──────────────
  // In production you would use PayMuxServer.create({ accept: ['mpp'], ... })
  // which delegates to mppx for HMAC-bound challenges. Here we build the
  // 402 response manually so the demo runs without mppx installed.

  const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const app = express();

  // Free endpoint — no payment required
  app.get('/api/time', (_req, res) => {
    res.json({ time: new Date().toISOString(), source: 'free endpoint' });
  });

  // Paid endpoint — $0.05 via MPP
  app.get('/api/weather', (req, res) => {
    const authHeader = req.headers['authorization'];

    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Payment ')) {
      // In production, mppx would verify the payment credential here.
      // For the demo, we show what happens when a credential arrives.
      res.json({
        weather: 'Sunny, 72F',
        price: '$0.05',
        paidVia: 'MPP (Tempo)',
        note: 'This is a simulated successful payment response',
      });
      return;
    }

    // No payment — return 402 with MPP challenge
    const challenge = buildMppChallenge({
      amount: 0.05,
      currency: 'USD',
      recipient: RECIPIENT,
      description: 'Weather data',
      realm: 'paymux-demo',
    });

    res.status(402);
    res.setHeader('WWW-Authenticate', challenge);
    res.json({
      error: 'Payment Required',
      message: 'This endpoint requires a payment of 0.05 USD',
      protocols: ['mpp'],
    });
  });

  // Expensive endpoint — $5.00 via MPP
  app.get('/api/research', (req, res) => {
    const challenge = buildMppChallenge({
      amount: 5.00,
      currency: 'USD',
      recipient: RECIPIENT,
      description: 'Deep research report',
      realm: 'paymux-demo',
    });

    res.status(402);
    res.setHeader('WWW-Authenticate', challenge);
    res.json({
      error: 'Payment Required',
      message: 'This endpoint requires a payment of 5.00 USD',
      protocols: ['mpp'],
    });
  });

  // Dual-protocol endpoint — both x402 and MPP
  app.get('/api/analysis', (req, res) => {
    const mppChallenge = buildMppChallenge({
      amount: 0.10,
      currency: 'USD',
      recipient: RECIPIENT,
      description: 'Market analysis',
      realm: 'paymux-demo',
    });

    // x402 PAYMENT-REQUIRED header (base64 JSON, same format as real x402)
    const x402Payload = btoa(JSON.stringify({
      x402Version: 2,
      accepts: [{
        scheme: 'exact',
        network: 'eip155:84532',
        maxAmountRequired: '100000',    // $0.10 in USDC base units (6 decimals)
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC on Base Sepolia
        payTo: RECIPIENT,
      }],
      resource: `http://localhost/api/analysis`,
    }));

    res.status(402);
    res.setHeader('WWW-Authenticate', mppChallenge);
    res.setHeader('Payment-Required', x402Payload);
    res.json({
      error: 'Payment Required',
      message: 'This endpoint requires a payment of 0.10 USD',
      protocols: ['mpp', 'x402'],
    });
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const BASE = `http://localhost:${port}`;

  console.log(`Server running on port ${port}`);
  console.log('  Free:  /api/time');
  console.log('  Paid:  /api/weather   ($0.05 MPP)');
  console.log('  Paid:  /api/research  ($5.00 MPP)');
  console.log('  Paid:  /api/analysis  ($0.10 MPP + x402)');
  console.log('');

  // ── 2. Create an agent (no wallet — shows detection only) ──────────
  const agent = PayMux.create({
    limits: { perRequest: 1.00, perDay: 10.00 },
    debug: true,
  });

  // ── Demo 1: Free endpoint ──────────────────────────────────────────
  console.log('--- Demo 1: Free endpoint (no payment) ---');
  console.log('');
  const timeRes = await agent.fetch(`${BASE}/api/time`);
  console.log(`  Status: ${timeRes.status}`);
  console.log(`  Data: ${JSON.stringify(await timeRes.json())}`);
  console.log('');
  console.log('  [OK] Free endpoints pass through with zero overhead.');
  console.log('  PayMux sends one request, sees 200, returns it. No payment logic runs.');
  console.log('');

  // ── Demo 2: MPP endpoint — protocol detection ──────────────────────
  console.log('--- Demo 2: MPP paid endpoint ($0.05) — protocol detection ---');
  console.log('');
  try {
    await agent.fetch(`${BASE}/api/weather`);
    console.log('  (This should not succeed without a wallet)');
  } catch (error) {
    const msg = (error as Error).message;
    console.log(`  PayMux detected MPP and reported:`);
    console.log(`  "${msg}"`);
    console.log('');
    console.log('  What happened behind the scenes:');
    console.log('    1. PayMux sent GET /api/weather');
    console.log('    2. Server returned 402 with WWW-Authenticate: Payment header');
    console.log('    3. PayMux parsed the MPP challenge and extracted:');
    console.log('       - Protocol: MPP');
    console.log('       - Amount: $0.05 USD');
    console.log('       - Method: tempo (Tempo chain)');
    console.log('    4. Spending limits passed ($0.05 < $1.00 per-request limit)');
    console.log('    5. No wallet configured, so PayMux reported the error');
    console.log('');
    console.log('  With a Tempo wallet, PayMux would:');
    console.log('    5. Sign a payment credential on the Tempo chain');
    console.log('    6. Retry the request with Authorization: Payment <credential>');
    console.log('    7. Return the paid response with a Payment-Receipt header');
  }
  console.log('');

  // ── Demo 3: Raw 402 response — what MPP headers look like ──────────
  console.log('--- Demo 3: Raw MPP 402 response (what the agent sees) ---');
  console.log('');
  const rawRes = await fetch(`${BASE}/api/weather`);
  console.log(`  Status: ${rawRes.status} ${rawRes.statusText}`);
  console.log('');

  const wwwAuth = rawRes.headers.get('www-authenticate');
  if (wwwAuth) {
    console.log('  WWW-Authenticate header (MPP challenge):');
    // Break up the long header for readability
    const parts = wwwAuth.split(', ');
    for (const part of parts) {
      if (part.startsWith('request=')) {
        // Decode the request payload for display
        const match = part.match(/request="([^"]*)"/);
        if (match) {
          const decoded = JSON.parse(atob(match[1].replace(/-/g, '+').replace(/_/g, '/')));
          console.log(`    request=<base64url JSON>:`);
          console.log(`      ${JSON.stringify(decoded, null, 6).split('\n').join('\n      ')}`);
        }
      } else {
        console.log(`    ${part}`);
      }
    }
  }
  console.log('');
  const body = await rawRes.json();
  console.log(`  Body: ${JSON.stringify(body, null, 2)}`);
  console.log('');
  console.log('  The MPP protocol flow:');
  console.log('    Client  -->  GET /api/weather');
  console.log('    Server  <--  402 + WWW-Authenticate: Payment id="...", method="tempo", request="..."');
  console.log('    Client  -->  GET /api/weather + Authorization: Payment <signed-credential>');
  console.log('    Server  <--  200 + Payment-Receipt: <base64url receipt>');
  console.log('');

  // ── Demo 4: Spending limits block expensive MPP requests ───────────
  console.log('--- Demo 4: Spending limits block overspend (MPP $5.00) ---');
  console.log('');

  const agentWithLimits = PayMux.create({
    wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
    limits: { perRequest: 1.00, perDay: 10.00 },
    debug: true,
  });

  console.log('  Agent config: perRequest=$1.00, perDay=$10.00');
  console.log('  Requesting /api/research which costs $5.00...');
  console.log('');
  try {
    await agentWithLimits.fetch(`${BASE}/api/research`);
    console.log('  (Should have been blocked)');
  } catch (error) {
    if (error instanceof SpendingLimitError) {
      console.log('  [OK] Spending limit blocked the payment BEFORE any money moved!');
      console.log(`    Limit type: ${error.limitType}`);
      console.log(`    Requested:  $${error.requestedAmount.toFixed(2)}`);
      console.log(`    Limit:      $${error.limit.toFixed(2)}`);
      console.log('');
      console.log('  This is critical for agent safety: the agent detected the MPP protocol,');
      console.log('  extracted the $5.00 price, and blocked it before attempting payment.');
    } else {
      console.log(`  Error: ${(error as Error).message}`);
    }
  }
  console.log('');

  // ── Demo 5: Dual-protocol detection (MPP + x402) ──────────────────
  console.log('--- Demo 5: Dual-protocol endpoint (MPP + x402) ---');
  console.log('');
  console.log('  When a server supports BOTH protocols, PayMux detects both and');
  console.log('  picks the best one. Default priority: MPP > x402 > card.');
  console.log('');

  const dualAgent = PayMux.create({
    limits: { perRequest: 1.00, perDay: 10.00 },
    debug: true,
  });

  try {
    await dualAgent.fetch(`${BASE}/api/analysis`);
  } catch (error) {
    const msg = (error as Error).message;
    // Check if MPP was detected (it should be preferred over x402)
    if (msg.includes('MPP') || msg.includes('mpp')) {
      console.log('  [OK] PayMux detected BOTH protocols and chose MPP (preferred).');
    } else {
      console.log(`  PayMux reported: "${msg}"`);
    }
    console.log('');
    console.log('  The 402 response contained:');
    console.log('    - WWW-Authenticate: Payment ... (MPP challenge)');
    console.log('    - Payment-Required: <base64 JSON>  (x402 requirements)');
    console.log('');
    console.log('  PayMux parsed both and selected MPP because:');
    console.log('    1. MPP supports session-based streaming (lower overhead per call)');
    console.log('    2. MPP settlement is faster on Tempo chain');
    console.log('    3. Protocol preference is configurable via preferProtocol option');
  }
  console.log('');

  // ── Demo 6: How MPP compares to x402 ──────────────────────────────
  console.log('--- Demo 6: MPP vs x402 — protocol comparison ---');
  console.log('');
  console.log('  +------------------+--------------------------+--------------------------+');
  console.log('  | Feature          | x402 (Coinbase)          | MPP (Stripe/Tempo)       |');
  console.log('  +------------------+--------------------------+--------------------------+');
  console.log('  | 402 Header       | Payment-Required         | WWW-Authenticate         |');
  console.log('  | Payment Header   | Payment-Signature        | Authorization: Payment   |');
  console.log('  | Receipt Header   | Payment-Response         | Payment-Receipt          |');
  console.log('  | Amount Format    | Base units (10000=$0.01) | Human-readable ($0.01)   |');
  console.log('  | Settlement       | Base/Polygon (USDC)      | Tempo chain (PathUSD)    |');
  console.log('  | Model            | Per-request micropayment | Session-based streaming  |');
  console.log('  | Challenge        | Static (no HMAC)         | HMAC-bound per request   |');
  console.log('  +------------------+--------------------------+--------------------------+');
  console.log('');
  console.log('  PayMux abstracts over both. Your agent code is identical:');
  console.log('    const response = await agent.fetch("https://api.example.com/data");');
  console.log('');

  // ── Summary ────────────────────────────────────────────────────────
  console.log('=======================================================');
  console.log('  Demo complete!');
  console.log('');
  console.log('  What you saw:');
  console.log('  [1] Free endpoints pass through (zero overhead)');
  console.log('  [2] MPP 402 challenges with WWW-Authenticate: Payment');
  console.log('  [3] PayMux auto-detects MPP from the challenge header');
  console.log('  [4] Spending limits enforce budgets before payment');
  console.log('  [5] Dual-protocol detection (MPP preferred over x402)');
  console.log('  [6] Protocol header comparison (MPP vs x402)');
  console.log('');
  console.log('  To make real MPP payments:');
  console.log('  1. Install mppx:       npm i -g mppx');
  console.log('  2. Create an account:  mppx account create');
  console.log('  3. Use the key:        PRIVATE_KEY=0x... npm run agent');
  console.log('');
  console.log('  MPP docs: https://mppx.dev');
  console.log('  PayMux:   https://github.com/anthropics/paymux');
  console.log('=======================================================');
  console.log('');

  server.close();
}

demo().catch(console.error);
