# PayMux

**The easiest way to make your API agent-payable.**

One middleware. x402 payments in 5 lines of code. MPP coming in v0.2.0.

> Stripe was 7 lines of JavaScript. What took weeks of bank negotiations, gateway contracts, and compliance paperwork became a 5-minute job. PayMux does the same for AI agent payments — what takes separate protocol integrations becomes a single `fetch()`.

---

### Make your API paid

```typescript
import { PayMuxServer } from 'paymux/server';

const payments = PayMuxServer.create({
  accept: ['x402'],
  x402: { recipient: '0x...', chain: 'base' },
});

// One line. Your API now accepts x402 payments from any agent.
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

// Auto-detects x402 from 402 response. Pays. Returns data.
const response = await agent.fetch('https://api.example.com/data');
```

---

## The Problem

AI agents need to pay for services. API developers need to get paid by agents. Multiple incompatible payment protocols are now live:

| Protocol | Backers | Model | Status |
|----------|---------|-------|--------|
| **x402** | Coinbase + Cloudflare | Per-request HTTP 402 micropayments | **Supported in v0.1.0** |
| **MPP** | Stripe + Tempo + Paradigm | Session-based streaming payments | Coming in v0.2.0 |
| **ACP** | OpenAI + Stripe | E-commerce checkout | Planned |

**For agent developers:** Integrate each protocol separately, detect which protocol a service accepts, handle signing and settlement independently.

**For API developers:** Choose a single protocol (losing agents on other protocols), or build 500+ lines of billing infrastructure.

**PayMux simplifies both sides.** Agent developers get a single `fetch()`. API developers get a single middleware.

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
│  payments.charge │                     │  agent.fetch(url) │
│  ({ $0.01 })     │                     │                   │
│                  │                     │  auto-detect →    │
│  Accepts:        │                     │  auto-pay →       │
│  • x402          │                     │  auto-retry →     │
│                  │                     │  return response  │
└──────────────────┘                     └──────────────────┘
```

### For agent developers

1. Agent calls `agent.fetch(url)`
2. PayMux sends the request via `@x402/fetch`
3. If non-402, returns the response immediately (1 HTTP call, zero overhead)
4. If 402, `@x402/fetch` automatically signs a USDC payment and retries (2 HTTP calls total)
5. Agent receives the response with data

### For API developers

1. Add `payments.charge()` middleware to any route
2. PayMux returns 402 with x402 payment requirements
3. Agent pays via x402 (on-chain USDC)
4. PayMux verifies payment via the x402 facilitator
5. PayMux settles on-chain and lets the request through

---

## Features

### Server Middleware (for API developers)

- **Accept x402 payments** -- single middleware to accept USDC micropayments
- **5 lines of code** -- works with Express, Hono, and Cloudflare Workers
- **Settlement routing** -- verifies and settles via the x402 facilitator
- **Per-request pricing** -- charge per API call
- **Deploy templates** -- Cloudflare Workers template included

### Client SDK (for agent developers)

- **Unified `fetch()`** -- auto-detects x402 from 402 responses and pays
- **Spending controls** -- per-request and per-day limits with concurrency safety
- **EVM wallet support** -- private key-based signing for Base, Polygon, Ethereum
- **Debug mode** -- `debug: true` for full payment flow logging

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
│                        PAYMUX v0.1.0                         │
│                                                              │
│  ┌────────────────────┐          ┌────────────────────────┐  │
│  │  paymux (client)   │          │  paymux/server         │  │
│  │                    │          │                        │  │
│  │  Protocol Detector │          │  x402 402 Response     │  │
│  │  x402 Client       │          │  Payment Verification  │  │
│  │  Spending Enforcer │◄────────►│  Settlement Router     │  │
│  │                    │          │                        │  │
│  │  (MPP: v0.2.0)     │          │  Express / Hono /      │  │
│  │  (Card: future)    │          │  CF Workers            │  │
│  └────────────────────┘          └────────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│  Protocol: x402 (v0.1.0) | MPP (v0.2.0) | Card (future)     │
├──────────────────────────────────────────────────────────────┤
│  Rails: Base / Polygon / Ethereum (USDC)                     │
└──────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 18 / TypeScript |
| x402 | `@x402/fetch`, `@x402/core`, `@x402/evm` |
| Signing | `viem` |
| Frameworks | Express, Hono, Cloudflare Workers |

---

## Roadmap

- [x] Market analysis and architecture design
- [x] Client SDK -- `agent.fetch()` with x402 auto-detection and payment
- [x] Server middleware -- accept x402 payments with one line
- [x] Spending controls (per-request, per-day limits)
- [x] Cloudflare Workers deploy template
- [ ] **v0.2.0** -- MPP protocol support (Stripe/Tempo)
- [ ] Service directory with quality scoring
- [ ] MCP integration for agent tool discovery
- [ ] Card payments via Visa TAP + mpp-card
- [ ] Python SDK

---

## Status

**v0.1.0** -- x402 protocol support on both client and server. Spending controls with concurrency safety. Express, Hono, and Cloudflare Workers middleware.

MPP (Stripe/Tempo) support ships in v0.2.0.

---

## License

MIT License. See [LICENSE](./LICENSE).
