# PayMux

**The easiest way to make your API agent-payable.**

One middleware. Every protocol. MPP, x402, and cards in 5 lines of code.

> Stripe was 7 lines of JavaScript. What took weeks of bank negotiations, gateway contracts, and compliance paperwork became a 5-minute job. PayMux does the same for AI agent payments — what takes separate integrations for MPP, x402, ACP, and card rails becomes a single `fetch()`.

---

### Make your API paid

```typescript
import { PayMuxServer } from 'paymux/server';

const payments = PayMuxServer.create({
  accept: ['mpp', 'x402'],
  mpp: { stripeSecretKey: process.env.STRIPE_KEY },
  x402: { recipient: '0x...', chain: 'base' },
});

// One line. Your API now accepts payments from any agent.
app.get('/api/data',
  payments.charge({ amount: 0.01, currency: 'USD' }),
  (req, res) => res.json({ data: '...' })
);
```

### Pay for any API

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

### Browse agent-payable APIs

Discover 500+ agent-payable APIs in the **[PayMux Directory](#service-directory)** — quality-scored, spam-filtered, and protocol-mapped.

---

## The Problem

AI agents need to pay for services. API developers need to get paid by agents. Three incompatible payment protocols are now live, and neither side has a simple solution:

| Protocol | Backers | Model |
|----------|---------|-------|
| **MPP** | Stripe + Tempo + Paradigm | Session-based streaming payments |
| **x402** | Coinbase + Cloudflare | Per-request HTTP 402 micropayments |
| **ACP** | OpenAI + Stripe | E-commerce checkout |

**For agent developers:** You must integrate each protocol separately, manually detect which protocol a service accepts, and handle routing, signing, and settlement independently.

**For API developers:** You must choose a single protocol, losing access to agents that use a different one. Adding billing infrastructure takes 500+ lines of Stripe code — or you lock into a marketplace that takes 25%.

**PayMux solves both sides.** Agent developers get a single `fetch()` that auto-detects and pays. API developers get a single middleware that accepts every protocol. The directory connects them.

---

## How It Works

```
   API DEVELOPER                              AGENT DEVELOPER
        │                                          │
        │  npm i paymux                            │  npm i paymux
        ▼                                          ▼
┌──────────────────┐                     ┌──────────────────┐
│  paymux/server   │                     │  paymux (client)  │
│                  │                     │                   │
│  payments.charge │    ┌──────────┐     │  agent.fetch(url) │
│  ({ $0.01 })     │◄──►│DIRECTORY │◄───►│                   │
│                  │    │          │     │  auto-detect →    │
│  Accepts:        │───►│ quality  │     │  auto-pay →       │
│  • MPP           │    │ scored   │     │  auto-retry →     │
│  • x402          │    └──────────┘     │  return response  │
│  • cards         │                     │                   │
└──────────────────┘                     └──────────────────┘
        │                                          │
        └──────► More APIs paid ◄──────────────────┘
                 More agents install
                 FLYWHEEL
```

### For agent developers

1. Agent calls `agent.fetch(url)`
2. PayMux sends the request
3. If the service returns HTTP 402, PayMux parses the response to detect the protocol
4. PayMux executes payment via MPP, x402, or card — whichever the service accepts
5. PayMux retries the original request with payment proof attached
6. Agent receives the response

### For API developers

1. Add `payments.charge()` middleware to any route
2. PayMux returns 402 with all supported protocols to any agent that requests it
3. Agent pays via whichever protocol it supports
4. PayMux verifies payment and lets the request through
5. Settlement routes automatically to Stripe (MPP) or Coinbase (x402)
6. Your API auto-registers in the PayMux directory

---

## Features

### Server Middleware (for API developers)

- **Accept all protocols** -- single middleware to accept MPP, x402, and card payments
- **5 lines of code** -- works with Express, Hono, Next.js, and Cloudflare Workers
- **Settlement routing** -- automatically routes to Stripe (MPP) or Coinbase facilitator (x402)
- **Per-request and session-based pricing** -- charge per API call or per second of compute
- **Auto-registration** -- your API is automatically listed in the PayMux directory
- **Revenue dashboard** -- see how much your API earns, which agents use it, protocol breakdown
- **Deploy templates** -- one-click deploy to Cloudflare Workers or Vercel

### Client SDK (for agent developers)

- **Unified `fetch()`** -- one call handles MPP, x402, ACP, and card payments
- **Auto protocol detection** -- parses 402 response headers to identify the payment protocol
- **Spending controls** -- per-request, per-session, and per-day limits with optional human-in-the-loop approval
- **Multi-wallet support** -- Privy, Coinbase Agent Wallets, or direct private keys
- **Session management** -- open long-running payment sessions with budget caps
- **Cross-protocol analytics** -- track spending across all payment rails

### Service Directory

- **Protocol discovery** -- query which protocols any service supports
- **Quality scoring** -- uptime, fidelity, and fraud detection scores
- **Spam filtering** -- filters out low-quality and fake endpoints
- **Auto-populated** -- services using paymux/server are automatically indexed

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
┌──────────────────────────────────────────────────────────────┐
│                        PAYMUX                                │
│                                                              │
│  ┌────────────────────┐          ┌────────────────────────┐  │
│  │  paymux (client)   │          │  paymux/server         │  │
│  │                    │          │                        │  │
│  │  Protocol Detector │          │  Multi-protocol 402    │  │
│  │  MPP Client (mppx) │          │  Settlement Router     │  │
│  │  x402 Client       │          │  Auto-registration     │  │
│  │  Card Client       │◄────────►│  Revenue Tracking      │  │
│  │  Spending Enforcer │          │                        │  │
│  │  Session Manager   │          │  Express / Hono /      │  │
│  │  Analytics         │          │  Next.js / CF Workers  │  │
│  └────────────────────┘          └────────────────────────┘  │
│                    │                        │                 │
│              ┌─────┴────────────────────────┴──────┐         │
│              │         SERVICE DIRECTORY            │         │
│              │  Discovery · Quality · Spam Filter   │         │
│              └─────────────────────────────────────┘         │
├──────────────────────────────────────────────────────────────┤
│  Protocols: MPP | x402 | ACP | Card                          │
├──────────────────────────────────────────────────────────────┤
│  Rails: Tempo | Base/Polygon/Solana | Visa/MC                │
└──────────────────────────────────────────────────────────────┘
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
