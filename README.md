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
│  • MPP           │                     │                   │
│                  │                     │  return response  │
└──────────────────┘                     └──────────────────┘
```

### For agent developers

1. Agent calls `agent.fetch(url)`
2. PayMux auto-detects the payment protocol (x402 or MPP)
3. If non-402, returns the response immediately (1 HTTP call, zero overhead)
4. If 402, the appropriate protocol client signs payment and retries (2 HTTP calls total)
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
│  │  (Card: future)    │          │  Express / Hono /      │  │
│  │                    │          │  CF Workers            │  │
│  └────────────────────┘          └────────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│  Protocols: x402 + MPP | Card (future)                       │
├──────────────────────────────────────────────────────────────┤
│  Rails: Base / Polygon / Ethereum (USDC) + Tempo (PathUSD)   │
└──────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 18 / TypeScript |
| x402 | `@x402/fetch`, `@x402/core`, `@x402/evm` |
| MPP | `mppx` (client + server) |
| Signing | `viem` |
| Frameworks | Express, Hono, Cloudflare Workers |

---

## Roadmap

- [x] Market analysis and architecture design
- [x] Client SDK -- `agent.fetch()` with multi-protocol auto-detection
- [x] Server middleware -- accept x402 + MPP payments with one line
- [x] x402 protocol support (Coinbase/Cloudflare)
- [x] MPP protocol support (Stripe/Tempo)
- [x] Spending controls (per-request, per-day limits)
- [x] Cloudflare Workers deploy template
- [ ] Service directory with quality scoring
- [ ] MCP integration for agent tool discovery
- [ ] Card payments via Visa TAP + mpp-card
- [ ] Python SDK

---

## Status

**v0.1.0** -- x402 and MPP protocol support on both client and server. Multi-protocol auto-detection and routing. Spending controls with concurrency safety. Express, Hono, and Cloudflare Workers middleware.

One `fetch()`. Two protocols. Zero code changes between them.

---

## License

MIT License. See [LICENSE](./LICENSE).
