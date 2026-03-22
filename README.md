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

### x402 Payment Flow

```
  AI Agent                 PayMux Client            Paid API                  PayMux Server           x402 Facilitator
     │                         │                       │                         │                         │
     │  agent.fetch(url)       │                       │                         │                         │
     │────────────────────────>│                       │                         │                         │
     │                         │                       │                         │                         │
     │                         │  1. GET /api/data     │                         │                         │
     │                         │──────────────────────>│                         │                         │
     │                         │                       │                         │                         │
     │                         │                       │  payments.charge()      │                         │
     │                         │                       │────────────────────────>│                         │
     │                         │                       │                         │                         │
     │                         │  2. 402 Payment Required                       │                         │
     │                         │  PAYMENT-REQUIRED: base64({                    │                         │
     │                         │    x402Version: 2,                             │                         │
     │                         │    accepts: [{                                 │                         │
     │                         │      scheme: "exact",                          │                         │
     │                         │      network: "eip155:8453",                   │                         │
     │                         │      maxAmountRequired: "10000",               │                         │
     │                         │      payTo: "0x...",                           │                         │
     │                         │      asset: "0x833589f..."                     │                         │
     │                         │    }]                                          │                         │
     │                         │  })                                            │                         │
     │                         │<─────────────────────│                         │                         │
     │                         │                       │                         │                         │
     │                         │  3. Check spending limits                      │                         │
     │                         │  ✓ perRequest: $0.01 < $1.00 limit             │                         │
     │                         │  ✓ perDay: $0.01 < $200.00 remaining           │                         │
     │                         │                       │                         │                         │
     │                         │  4. Sign USDC payment on-chain                 │                         │
     │                         │  (via @x402/fetch + viem)                      │                         │
     │                         │                       │                         │                         │
     │                         │  5. GET /api/data     │                         │                         │
     │                         │  PAYMENT-SIGNATURE: base64(signed_payment)     │                         │
     │                         │──────────────────────>│                         │                         │
     │                         │                       │                         │                         │
     │                         │                       │  Verify payment         │                         │
     │                         │                       │────────────────────────>│                         │
     │                         │                       │                         │  POST /verify            │
     │                         │                       │                         │────────────────────────>│
     │                         │                       │                         │  { isValid: true }       │
     │                         │                       │                         │<────────────────────────│
     │                         │                       │                         │                         │
     │                         │                       │                         │  POST /settle            │
     │                         │                       │                         │────────────────────────>│
     │                         │                       │                         │  { success: true,        │
     │                         │                       │                         │    transaction: "0x..." } │
     │                         │                       │                         │<────────────────────────│
     │                         │                       │                         │                         │
     │                         │  6. 200 OK            │                         │                         │
     │                         │  Payment-Response: base64({success, tx})       │                         │
     │                         │  Body: { data: "premium content" }             │                         │
     │                         │<─────────────────────│                         │                         │
     │                         │                       │                         │                         │
     │                         │  7. Record payment in spending tracker         │                         │
     │                         │  dailySpend += $0.01                           │                         │
     │                         │                       │                         │                         │
     │  response.json()        │                       │                         │                         │
     │  { data: "premium" }    │                       │                         │                         │
     │<────────────────────────│                       │                         │                         │
```

### MPP Payment Flow

```
  AI Agent                 PayMux Client            Paid API                  PayMux Server           Tempo Chain
     │                         │                       │                         │                         │
     │  agent.fetch(url)       │                       │                         │                         │
     │────────────────────────>│                       │                         │                         │
     │                         │                       │                         │                         │
     │                         │  1. GET /api/data     │                         │                         │
     │                         │──────────────────────>│                         │                         │
     │                         │                       │                         │                         │
     │                         │  2. 402 Payment Required                       │                         │
     │                         │  WWW-Authenticate: Payment                     │                         │
     │                         │    id="hmac_challenge",                        │                         │
     │                         │    realm="paymux",                             │                         │
     │                         │    method="tempo",                             │                         │
     │                         │    intent="charge",                            │                         │
     │                         │    request="base64url(amount, recipient)"      │                         │
     │                         │<─────────────────────│                         │                         │
     │                         │                       │                         │                         │
     │                         │  3. Check spending limits                      │                         │
     │                         │  ✓ perRequest / perDay checks                 │                         │
     │                         │                       │                         │                         │
     │                         │  4. Sign payment on Tempo                      │                         │
     │                         │  (via mppx scoped fetch)       │               │                         │
     │                         │                       │                         │                         │
     │                         │  5. GET /api/data     │                         │                         │
     │                         │  Authorization: Payment base64url(credential)  │                         │
     │                         │──────────────────────>│                         │                         │
     │                         │                       │                         │                         │
     │                         │                       │  Verify HMAC +          │                         │
     │                         │                       │  credential             │                         │
     │                         │                       │────────────────────────>│                         │
     │                         │                       │                         │  Verify on-chain         │
     │                         │                       │                         │────────────────────────>│
     │                         │                       │                         │  ✓ Confirmed             │
     │                         │                       │                         │<────────────────────────│
     │                         │                       │                         │                         │
     │                         │  6. 200 OK            │                         │                         │
     │                         │  Payment-Receipt: base64url({                  │                         │
     │                         │    status: "success",                          │                         │
     │                         │    method: "tempo",                            │                         │
     │                         │    reference: "0x...",                         │                         │
     │                         │    timestamp: "2026-03-21T..."                 │                         │
     │                         │  })                                            │                         │
     │                         │  Body: { data: "premium content" }             │                         │
     │                         │<─────────────────────│                         │                         │
     │                         │                       │                         │                         │
     │                         │  7. Record payment in spending tracker         │                         │
     │                         │                       │                         │                         │
     │  response.json()        │                       │                         │                         │
     │  { data: "premium" }    │                       │                         │                         │
     │<────────────────────────│                       │                         │                         │
```

### Non-Payment Flow (Zero Overhead)

```
  AI Agent                 PayMux Client            Free API
     │                         │                       │
     │  agent.fetch(url)       │                       │
     │────────────────────────>│                       │
     │                         │  GET /api/free        │
     │                         │──────────────────────>│
     │                         │                       │
     │                         │  200 OK               │
     │                         │  { data: "free" }     │
     │                         │<─────────────────────│
     │                         │                       │
     │  response.json()        │  (1 HTTP call,        │
     │  { data: "free" }       │   no payment logic    │
     │<────────────────────────│   executed)            │
```

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
