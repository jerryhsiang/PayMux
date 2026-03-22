/**
 * PayMux Quickstart — Step 1: The Paid API Server
 *
 * This is a simple Express API with one free endpoint and one paid endpoint.
 * The paid endpoint charges $0.01 via x402 (USDC on Base Sepolia testnet).
 *
 * Run: npm run server
 */

import express from 'express';
import { PayMuxServer } from 'paymux/server';

const app = express();

// ── Configure PayMux to accept x402 payments ────────────────────
const payments = PayMuxServer.create({
  accept: ['x402'],
  x402: {
    // This address receives the payments. Replace with YOUR wallet address.
    recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    // Use Base Sepolia testnet (free testnet USDC)
    chain: 'base-sepolia',
  },
});

// ── Free endpoint ───────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'PayMux Quickstart API',
    endpoints: {
      '/': 'This info (free)',
      '/api/joke': '$0.01 — Get a random joke (paid)',
      '/api/time': 'Current time (free)',
    },
  });
});

app.get('/api/time', (_req, res) => {
  res.json({ time: new Date().toISOString(), free: true });
});

// ── Paid endpoint — $0.01 per joke ──────────────────────────────
app.get(
  '/api/joke',
  payments.charge({ amount: 0.01, currency: 'USD', description: 'Random joke' }),
  (_req, res) => {
    const jokes = [
      'Why do programmers prefer dark mode? Because light attracts bugs.',
      "There are only 10 types of people: those who understand binary and those who don't.",
      'A SQL query walks into a bar, sees two tables, and asks... "Can I JOIN you?"',
      'Why did the developer go broke? Because he used up all his cache.',
      "What's a programmer's favorite hangout? Foo Bar.",
      'Why do Java developers wear glasses? Because they can\'t C#.',
      '!false — it\'s funny because it\'s true.',
    ];
    const joke = jokes[Math.floor(Math.random() * jokes.length)];
    res.json({ joke, price: '$0.01', paidVia: 'paymux x402' });
  }
);

// ── Start server ────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 PayMux Quickstart Server running!');
  console.log('');
  console.log(`   Free:  http://localhost:${PORT}/api/time`);
  console.log(`   Paid:  http://localhost:${PORT}/api/joke  ($0.01)`);
  console.log('');
  console.log('Try it:');
  console.log(`   curl http://localhost:${PORT}/api/time     # Free — works`);
  console.log(`   curl http://localhost:${PORT}/api/joke     # Paid — returns 402`);
  console.log('');
  console.log('To pay, run the agent: npm run agent');
  console.log('');
});
