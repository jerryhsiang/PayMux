/**
 * PayMux Quickstart — Step 2: The Paying Agent
 *
 * This agent pays for the /api/joke endpoint using x402 (testnet USDC).
 * It demonstrates:
 * - Auto-detecting the payment protocol from a 402 response
 * - Spending limits (perRequest, perDay)
 * - Debug logging to see the full payment flow
 *
 * Prerequisites:
 * 1. Start the server: npm run server
 * 2. Set PRIVATE_KEY environment variable (a funded Base Sepolia wallet)
 *
 * Run: PRIVATE_KEY=0x... npm run agent
 */

import { PayMux } from 'paymux';

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;

if (!PRIVATE_KEY || PRIVATE_KEY === '0x') {
  console.error('');
  console.error('❌ PRIVATE_KEY not set.');
  console.error('');
  console.error('To run this demo, you need a wallet with testnet USDC on Base Sepolia.');
  console.error('');
  console.error('Quick setup:');
  console.error('  1. Create a wallet (e.g., MetaMask) and export the private key');
  console.error('  2. Get Base Sepolia ETH: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet');
  console.error('  3. Get testnet USDC: bridge or faucet (check Base Sepolia docs)');
  console.error('  4. Run: PRIVATE_KEY=0xYourKey npm run agent');
  console.error('');
  console.error('Or run the local demo (no wallet needed): npm run demo');
  console.error('');
  process.exit(1);
}

// ── Create the PayMux agent ─────────────────────────────────────
const agent = PayMux.create({
  wallet: { privateKey: PRIVATE_KEY },
  limits: {
    perRequest: 0.10,  // Max $0.10 per request
    perDay: 1.00,      // Max $1.00 per day
  },
  debug: true, // Show the full payment flow
});

async function main() {
  const SERVER = 'http://localhost:3000';

  console.log('');
  console.log('🤖 PayMux Agent starting...');
  console.log('');

  // ── 1. Free endpoint — no payment needed ──────────────────────
  console.log('── Step 1: Fetching free endpoint ──');
  const timeResponse = await agent.fetch(`${SERVER}/api/time`);
  const timeData = await timeResponse.json();
  console.log('Result:', timeData);
  console.log(`Spending so far: $${agent.spending.totalSpent.toFixed(2)}`);
  console.log('');

  // ── 2. Paid endpoint — PayMux auto-detects and pays ───────────
  console.log('── Step 2: Fetching paid endpoint ($0.01) ──');
  try {
    const jokeResponse = await agent.fetch(`${SERVER}/api/joke`);
    const jokeData = await jokeResponse.json();
    console.log('Result:', jokeData);
    console.log(`Spending so far: $${agent.spending.totalSpent.toFixed(6)}`);
  } catch (error) {
    console.error('Payment failed:', (error as Error).message);
    console.error('');
    console.error('This is expected if:');
    console.error('  - Your wallet has no testnet USDC');
    console.error('  - The server is not running (start it: npm run server)');
  }
  console.log('');

  // ── 3. Show spending summary ──────────────────────────────────
  console.log('── Spending Summary ──');
  const spending = agent.spending;
  console.log(`  Total spent:     $${spending.totalSpent.toFixed(6)}`);
  console.log(`  Daily remaining: $${spending.dailyRemaining?.toFixed(2) ?? 'unlimited'}`);
  console.log(`  Payments made:   ${spending.history.length}`);
  if (spending.history.length > 0) {
    const last = spending.history[spending.history.length - 1];
    console.log(`  Last payment:    ${last.amount} ${last.currency} via ${last.protocol}`);
    if (last.transactionHash) {
      console.log(`  Transaction:     ${last.transactionHash}`);
    }
  }
  console.log('');
}

main().catch(console.error);
