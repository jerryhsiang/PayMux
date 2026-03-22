# PayMux

**The easiest way to make your API agent-payable.**

One SDK. Every protocol. x402 + MPP in a single `fetch()`.

> Stripe was 7 lines of JavaScript. What took weeks of bank negotiations, gateway contracts, and compliance paperwork became a 5-minute job. PayMux does the same for AI agent payments — what takes separate protocol integrations becomes a single `fetch()`.

---

### Make your API paid

```typescript
import { PayMuxServer } from 'paymux/server';

const payments = PayMuxServer.create({
  accept: ['x402', 'mpp'],
  x402: { recipient: '0x...', chain: 'base' },
  mpp: { secretKey: process.env.MPP_SECRET_KEY, tempoRecipient: '0x...' },
});

// One line. Your API now accepts payments from any agent, any protocol.
app.get('/api/data',
  payments.charge({ amount: 0.01, currency: 'USD' }),
  (req, res) => res.json({ data: '...' })
);
```

### Pay for any API

```typescript
import { PayMux } from 'paymux';

const agent = PayMux.create({
  wallet: { privateKey: '0x...' },
  limits: { perRequest: 1.00, perDay: 200.00 },
});

// Auto-detects protocol (x402 or MPP). Pays. Returns data.
const response = await agent.fetch('https://api.example.com/data');
```

---

## The Problem

AI agents need to pay for services. API developers need to get paid by agents. Multiple incompatible payment protocols are now live:

| Protocol | Backers | Model | Status |
|----------|---------|-------|--------|
| **x402** | Coinbase + Cloudflare | Per-request HTTP 402 micropayments | **Supported** |
| **MPP** | Stripe + Tempo + Paradigm | Session-based streaming payments | **Supported** |
| **Visa TAP** | Visa + 21 banks | Card-based agent payments via [Trusted Agent Protocol](https://github.com/visa/trusted-agent-protocol) | Planned |

**For agent developers:** Integrate each protocol separately, detect which protocol a service accepts, handle signing and settlement independently.

**For API developers:** Choose a single protocol (losing agents on other protocols), or build 500+ lines of billing infrastructure.

**PayMux simplifies both sides.** Agent developers get a single `fetch()`. API developers get a single middleware.

---

## How It Works

### For agent developers

1. Agent calls `agent.fetch(url)`
2. PayMux auto-detects the payment protocol (x402 or MPP)
3. If non-402, returns the response immediately (1 HTTP call, zero overhead)
4. If 402, the appropriate protocol client signs payment and retries
5. Agent receives the response with data — same code for x402 and MPP endpoints

### For API developers

1. Add `payments.charge()` middleware to any route
2. PayMux returns 402 with payment requirements for all configured protocols
3. Agent pays via whichever protocol it supports (x402 or MPP)
4. PayMux verifies payment and settles
5. Request proceeds — your handler runs, agent gets data

---

## Features

### Server Middleware (for API developers)

- **Accept all protocols** -- single middleware accepts x402 and MPP payments
- **5 lines of code** -- works with Express, Hono, and Cloudflare Workers
- **Multi-protocol 402** -- returns payment requirements for all configured protocols
- **Settlement routing** -- x402 via Coinbase facilitator, MPP via Tempo chain
- **Per-request pricing** -- charge per API call
- **Deploy templates** -- Cloudflare Workers template included

### Client SDK (for agent developers)

- **Unified `fetch()`** -- auto-detects x402 or MPP from 402 responses and pays
- **Multi-protocol routing** -- same `agent.fetch()` works for x402 and MPP endpoints
- **Spending controls** -- per-request and per-day limits with concurrency safety
- **EVM wallet support** -- private key-based signing for Base, Polygon, Ethereum
- **Debug mode** -- `debug: true` for full payment flow logging
- **Retry logic** -- automatic retries on transient failures (502, 503, 504)
- **Sessions** -- budget-scoped payment sessions for multi-request workflows
- **Custom timeouts** -- configurable probe and payment settlement timeouts
- **Custom logger** -- plug in your own structured logger or disable logging entirely

### Retry Logic

Retries transient errors (502/503/504) with exponential backoff. Safe methods (GET/HEAD) only by default.

```typescript
const agent = PayMux.create({
  wallet: { privateKey: '0x...' },
  retry: { maxRetries: 2, baseDelayMs: 1000 }, // defaults
});

// Disable retries entirely
const agent2 = PayMux.create({ retry: false });
```

### Custom Logger

Replace the default `console.log` debug output with your own structured logger, or disable logging.

```typescript
const agent = PayMux.create({
  wallet: { privateKey: '0x...' },
  logger: {
    debug: (msg, data) => myLogger.debug(msg, data),
    info:  (msg, data) => myLogger.info(msg, data),
    warn:  (msg, data) => myLogger.warn(msg, data),
    error: (msg, data) => myLogger.error(msg, data),
  },
});

// Disable all logging (overrides debug: true)
const silent = PayMux.create({ logger: false });
```

### Sessions

Budget-scoped sessions for multi-request workflows. The session budget is reserved upfront against global limits and released on close.

```typescript
const session = await agent.openSession({
  url: 'https://api.example.com',
  budget: 5.00,       // max $5 for this session
  duration: 3600000,  // 1 hour (default)
});

const res1 = await session.fetch('/api/data?q=foo');
const res2 = await session.fetch('/api/data?q=bar');
console.log(session.spending); // { spent, remaining, requestCount, ... }

await session.close(); // releases unspent budget
```

### Timeouts

Configure how long PayMux waits for protocol detection probes and payment settlement.

```typescript
const agent = PayMux.create({
  wallet: { privateKey: '0x...' },
  timeouts: {
    probeMs: 5000,    // protocol detection timeout (default: 10000)
    paymentMs: 15000, // payment settlement timeout (default: 30000)
  },
});
```

---

## Install

```bash
npm install paymux
```

Then install peer dependencies for the protocols you need:

| Protocol | Peer Dependencies | Install Command |
|----------|------------------|-----------------|
| **x402** (Coinbase) | `@x402/core` `@x402/evm` `viem` | `npm install @x402/core @x402/evm viem` |
| **MPP** (Stripe/Tempo) | `mppx` `viem` | `npm install mppx viem` |
| **Both protocols** | All of the above | `npm install @x402/core @x402/evm mppx viem` |

> **Note:** `mppx` requires Express 5+. If you're on Express 4, install with `--legacy-peer-deps`:
> ```bash
> npm install mppx viem --legacy-peer-deps
> ```
> PayMux's server middleware works with both Express 4 and 5.

For server middleware, also install your framework:

```bash
npm install express  # or: npm install hono
```

---

## Quick Start

### x402 (Coinbase) — Server

```typescript
import express from 'express';
import { PayMuxServer } from 'paymux/server';

const app = express();
const payments = PayMuxServer.create({
  accept: ['x402'],
  x402: {
    recipient: '0xYourWalletAddress',
    chain: 'base-sepolia', // or 'base' for mainnet
  },
});

app.get('/api/data',
  payments.charge({ amount: 0.01, currency: 'USD' }),
  (req, res) => res.json({ data: 'premium content' })
);

app.listen(3000);
```

### x402 (Coinbase) — Agent

```typescript
import { PayMux } from 'paymux';

const agent = PayMux.create({
  wallet: { privateKey: '0x...' },
  limits: { perRequest: 1.00, perDay: 200.00 },
});

const response = await agent.fetch('http://localhost:3000/api/data');
const data = await response.json();
```

### MPP (Stripe/Tempo) — Server

```typescript
import express from 'express';
import { PayMuxServer } from 'paymux/server';

const app = express();
const payments = PayMuxServer.create({
  accept: ['mpp'],
  mpp: {
    secretKey: process.env.MPP_SECRET_KEY!, // See "MPP Configuration" below
    tempoRecipient: '0xYourWalletAddress',
    testnet: true, // false for mainnet
  },
});

app.get('/api/data',
  payments.charge({ amount: 0.01 }),
  (req, res) => res.json({ data: 'premium content' })
);

app.listen(3000);
```

### MPP (Stripe/Tempo) — Agent

```typescript
import { PayMux } from 'paymux';

// Same code as x402 — PayMux auto-detects the protocol
const agent = PayMux.create({
  wallet: { privateKey: '0x...' },
  limits: { perRequest: 1.00, perDay: 200.00 },
});

const response = await agent.fetch('http://localhost:3000/api/data');
```

### Both Protocols — Server accepts x402 AND MPP

```typescript
const payments = PayMuxServer.create({
  accept: ['x402', 'mpp'],
  x402: { recipient: '0x...', chain: 'base' },
  mpp: {
    secretKey: process.env.MPP_SECRET_KEY!,
    tempoRecipient: '0x...',
  },
});
```

The agent code doesn't change — `agent.fetch()` works with any protocol.

### Try it locally (no wallet needed)

```bash
git clone https://github.com/jerryhsiang/PayMux.git
cd PayMux/examples/quickstart
npm install
npm run demo
```

---

## MPP Configuration

The MPP server config has three fields that need explanation:

### `secretKey` — HMAC verification key

The `secretKey` is an HMAC key used for stateless verification of payment challenges. It binds each 402 challenge to its contents so the server can verify payments without storing session state.

**Generate it once and store it permanently.** It must persist across server restarts and deploys. If you rotate it, all in-flight payment challenges become invalid.

```bash
# Generate once, add to your .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```env
MPP_SECRET_KEY=your_generated_key_here
```

```typescript
mpp: {
  secretKey: process.env.MPP_SECRET_KEY!, // Persistent key from .env — NOT crypto.randomBytes()
}
```

### `tempoRecipient` — Your wallet on Tempo chain

[Tempo](https://tempo.xyz) is a sub-second finality blockchain (EVM-compatible) purpose-built for payments by the team behind MPP. Settlement costs <$0.001. Payments settle in **PathUSD**, a USD-pegged stablecoin native to Tempo.

**PathUSD** uses 6 decimal places (like USDC), with token address `0x20c0000000000000000000000000000000000000` on Tempo. PayMux handles the conversion automatically -- developers always specify amounts in human-readable USD (e.g., `0.01` = one cent). The underlying base-unit conversion (e.g., `0.01` becomes `10000` in 6-decimal base units) is internal to PayMux and the MPP protocol.

`tempoRecipient` is a standard Ethereum/EVM wallet address where PathUSD payments land. Any EVM address works -- you do not need a special Tempo account.

For testnet development, create an auto-funded account:

```bash
npm i -g mppx
mppx account create   # Generates a wallet and funds it on Tempo testnet
```

### `stripeSecretKey` — Optional card-based MPP

When provided, the server accepts both Tempo (crypto) and Stripe (card) payment methods through MPP. Agents that prefer card payments can pay via Stripe, while crypto-native agents pay via Tempo.

Under the hood, PayMux uses **Stripe Payment Intents** with `card` and `link` payment methods. Stripe handles all PCI compliance for card data — no sensitive card information touches your server.

The `stripeSecretKey` must be a Stripe secret key (`sk_test_...` for testing or `sk_live_...` for production). You can find it in the [Stripe Dashboard](https://dashboard.stripe.com/apikeys) under Developers > API keys.

```typescript
mpp: {
  secretKey: process.env.MPP_SECRET_KEY!,
  tempoRecipient: '0x...',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY, // Optional: enables card payments via MPP
}
```

**Reconciliation:** MPP receipts include a `reference` field. For Stripe-settled payments, this maps to the Stripe Payment Intent ID (e.g., `pi_3abc...`), which you can look up in the Stripe Dashboard or API.

**Refunds:** Not currently supported through PayMux. Use the [Stripe Dashboard](https://dashboard.stripe.com/payments) or Stripe API directly to issue refunds on Payment Intents.

**Webhooks:** Not yet supported. To track payment status changes (disputes, refunds, failures), configure [Stripe webhooks](https://docs.stripe.com/webhooks) directly for now.

---

## Supported Chains

| Chain | Network ID | Status |
|-------|-----------|--------|
| Base | eip155:8453 | Mainnet |
| Base Sepolia | eip155:84532 | Testnet |
| Polygon | eip155:137 | Mainnet |
| Ethereum | eip155:1 | Mainnet |

All chains use USDC with correct contract addresses.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                          PAYMUX                              │
│                                                              │
│  ┌────────────────────┐          ┌────────────────────────┐  │
│  │  paymux (client)   │          │  paymux/server         │  │
│  │                    │          │                        │  │
│  │  Protocol Detector │          │  Multi-protocol 402    │  │
│  │  x402 Client       │          │  x402 Verification     │  │
│  │  MPP Client        │◄────────►│  MPP Verification      │  │
│  │  Spending Enforcer │          │  Settlement Router     │  │
│  │                    │          │                        │  │
│  │  (Visa TAP: next)  │          │  Express / Hono /      │  │
│  │                    │          │  CF Workers            │  │
│  └────────────────────┘          └────────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│  Protocols: x402 + MPP | Visa TAP (next)                     │
├──────────────────────────────────────────────────────────────┤
│  Rails: Base / Polygon / Ethereum (USDC) + Tempo (PathUSD)   │
└──────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 18 / TypeScript |
| x402 | `@x402/core`, `@x402/evm` |
| MPP | `mppx` (client + server) |
| Signing | `viem` |
| Frameworks | Express, Hono, Cloudflare Workers |

---

## License

MIT License. See [LICENSE](./LICENSE).
