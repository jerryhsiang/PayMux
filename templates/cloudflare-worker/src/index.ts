/**
 * PayMux Cloudflare Worker Template
 *
 * Deploy a paid API in one click. Accepts x402 + MPP payments from any AI agent.
 *
 * 1. Set your RECIPIENT_ADDRESS in wrangler.toml
 * 2. Run: npm run deploy
 * 3. Your API now accepts payments from any PayMux-enabled agent
 */

import { Hono } from 'hono';
import { PayMuxServer } from 'paymux/server';

type Env = {
  RECIPIENT_ADDRESS: string;
  CHAIN: string;
};

const app = new Hono<{ Bindings: Env }>();

/**
 * Middleware factory — creates PayMuxServer from env bindings.
 * CF Workers env is only available per-request, so we cache per-isolate.
 */
let cachedPayments: ReturnType<typeof PayMuxServer.create> | null = null;
let cachedRecipient: string | null = null;

function getPayments(env: Env) {
  if (cachedPayments && cachedRecipient === env.RECIPIENT_ADDRESS) {
    return cachedPayments;
  }
  cachedPayments = PayMuxServer.create({
    accept: ['x402'],
    x402: {
      recipient: env.RECIPIENT_ADDRESS as `0x${string}`,
      chain: env.CHAIN || 'base-sepolia',
    },
  });
  cachedRecipient = env.RECIPIENT_ADDRESS;
  return cachedPayments;
}

// Free endpoint — no payment required
app.get('/', (c) => {
  return c.json({
    name: 'My Paid API',
    description: 'A paid API powered by PayMux',
    endpoints: {
      '/': 'This info page (free)',
      '/api/joke': '$0.01 — Get a random joke',
      '/api/data': '$0.05 — Get premium data',
    },
    poweredBy: 'https://paymux.dev',
  });
});

// Paid endpoint — $0.01 per joke
// Middleware registered properly: app.use() for payment gate, app.get() for handler
app.use('/api/joke', async (c, next) => {
  const payments = getPayments(c.env);
  const mw = payments.charge({ amount: 0.01, currency: 'USD', description: 'Random joke' });
  return mw(c, next);
});

app.get('/api/joke', (c) => {
  const jokes = [
    'Why do programmers prefer dark mode? Because light attracts bugs.',
    "There are only 10 types of people in the world: those who understand binary and those who don't.",
    'A SQL query walks into a bar, sees two tables, and asks... "Can I JOIN you?"',
    'Why did the developer go broke? Because he used up all his cache.',
    "What's a programmer's favorite hangout? Foo Bar.",
  ];
  const joke = jokes[Math.floor(Math.random() * jokes.length)];
  return c.json({ joke, paidVia: 'paymux' });
});

// Paid endpoint — $0.05 per data request
app.use('/api/data', async (c, next) => {
  const payments = getPayments(c.env);
  const mw = payments.charge({ amount: 0.05, currency: 'USD', description: 'Premium data' });
  return mw(c, next);
});

app.get('/api/data', (c) => {
  return c.json({
    data: {
      timestamp: new Date().toISOString(),
      value: Math.random() * 100,
      source: 'paymux-worker-template',
    },
    paidVia: 'paymux',
  });
});

export default app;
