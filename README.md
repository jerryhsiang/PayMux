# PayMux

**Multi-protocol payment routing SDK for AI agents.**

One SDK. Any payment protocol. Any rail.

```typescript
import { PayMux } from 'paymux';

const agent = PayMux.create({
  wallet: { privy: { walletId: 'wlt_...' } },
  card: { stripe: { customerId: 'cus_...' } },
  limits: { perRequest: 1.00, perDay: 200.00 },
});

// Auto-detects protocol. Routes optimally. Handles 402 challenges.
const response = await agent.fetch('https://api.example.com/data');
```

---

## The Problem

AI agents need to pay for services. Three incompatible payment protocols are now live:

| Protocol | Backers | Model |
|----------|---------|-------|
| **MPP** | Stripe + Tempo + Paradigm | Session-based streaming payments |
| **x402** | Coinbase + Cloudflare | Per-request HTTP 402 micropayments |
| **ACP** | OpenAI + Stripe | E-commerce checkout |

Developers today must integrate each protocol separately, manually detect which protocol a service accepts, and handle routing, signing, and settlement for each one independently.

**PayMux is the unification layer.** It auto-detects the protocol, routes to the optimal rail, and handles the entire payment flow in a single `fetch()` call.

---

## How It Works

```
AI Agent
  │
  ▼
PayMux SDK ──── auto-detect protocol from 402 response
  │
  ├── MPP (Stripe/Tempo)  → session-based, multi-rail
  ├── x402 (Coinbase)     → per-request, on-chain
  ├── ACP (OpenAI)        → e-commerce checkout
  └── Card fallback       → Visa/Mastercard via tokenized credentials
```

1. Agent calls `agent.fetch(url)`
2. PayMux sends the request
3. If the service returns HTTP 402, PayMux parses the response headers to identify the protocol (MPP vs x402 vs ACP)
4. PayMux executes the payment using the appropriate method
5. PayMux retries the original request with payment proof attached
6. Agent receives the response

---

## Features

### Client SDK (for agent developers)

- **Unified `fetch()`** -- one call handles MPP, x402, ACP, and card payments
- **Auto protocol detection** -- parses 402 response headers to identify the payment protocol
- **Spending controls** -- per-request, per-session, and per-day limits with optional human-in-the-loop approval
- **Multi-wallet support** -- Privy, Coinbase Agent Wallets, or direct private keys
- **Session management** -- open long-running payment sessions with budget caps
- **Cross-protocol analytics** -- track spending across all payment rails

### Server Middleware (for service providers)

- **Accept all protocols** -- single middleware to accept MPP, x402, and card payments
- **One-line integration** -- works with Express, Hono, Next.js, and Cloudflare Workers
- **Settlement routing** -- automatically routes to Stripe (MPP) or Coinbase facilitator (x402)
- **Per-request and session-based pricing** -- charge per API call or per second of compute

### Service Directory

- **Protocol discovery** -- query which protocols any service supports
- **Quality scoring** -- uptime, fidelity, and fraud detection scores
- **Spam filtering** -- filters out low-quality and fake endpoints

---

## Server Middleware

```typescript
import { PayMuxServer } from 'paymux/server';

const payments = PayMuxServer.create({
  accept: ['mpp', 'x402', 'card'],
  mpp: {
    stripeSecretKey: process.env.STRIPE_KEY,
    tempoRecipient: '0x...',
  },
  x402: {
    facilitator: 'coinbase',
    recipient: '0x...',
    chain: 'base',
  },
  preferredRail: 'mpp',
});

// Make any endpoint paid
app.get('/api/data',
  payments.charge({ amount: 0.01, currency: 'USD' }),
  (req, res) => res.json({ data: '...' })
);
```

---

## API

```
POST /v1/payments              Route a payment across protocols
POST /v1/sessions              Open a payment session
GET  /v1/services/{domain}     Query protocol support for a service
GET  /v1/directory              Browse the service directory
GET  /v1/directory/search       Search by category
GET  /v1/spending/{agent_id}   Cross-protocol spending analytics
GET  /v1/routing/optimal       Get optimal payment route
GET  /v1/rates                 Real-time settlement cost comparison
```

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   AI AGENT                           │
├──────────────────────────────────────────────────────┤
│  PayMux SDK                                          │
│  ├── Protocol Detector (parse 402 headers)           │
│  ├── MPP Client (wraps mppx)                         │
│  ├── x402 Client (wraps @x402/fetch)                 │
│  ├── Card Client (Visa token spec)                   │
│  ├── Spending Enforcer (limits, approvals)            │
│  └── Analytics Collector                             │
├──────────────────────────────────────────────────────┤
│  Protocols: MPP | x402 | ACP | Card                  │
├──────────────────────────────────────────────────────┤
│  Rails: Tempo | Base/Polygon/Solana | Visa/MC        │
└──────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js / TypeScript |
| Protocols | `mppx`, `@x402/fetch`, `@x402/express`, `@coinbase/x402` |
| Frameworks | Express, Hono, Next.js, Cloudflare Workers |
| Database | PostgreSQL (directory, quality scores, analytics) |
| Cache | Redis (capability cache, rate limiting) |
| Deployment | Cloudflare Workers (edge) + Railway (API/DB) |

---

## Roadmap

- [x] Market analysis and architecture design
- [ ] Client SDK -- unified `fetch()` with MPP + x402 auto-detection
- [ ] Server middleware -- accept all protocols with one integration
- [ ] Service directory with quality scoring and spam filtering
- [ ] Spending controls and cross-protocol analytics
- [ ] MCP integration for agent tool discovery
- [ ] Python SDK

---

## Status

Early development. The protocols are live -- MPP launched March 18, 2026 with 100+ services, x402 has been live since May 2025. The routing layer that unifies them does not exist yet. We're building it.

---

## License

Proprietary. All rights reserved.
