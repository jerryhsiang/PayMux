# Agent Payment Routing — Competitive Landscape & Product Opportunity

---

## THE CORE THESIS

> **The routing layer — where an agent calls `fetch()` and the SDK auto-detects whether the endpoint speaks MPP, x402, ACP, or needs a card — remains COMPLETELY UNBUILT.**

Nobody is building the multi-protocol abstraction. Every startup is either protocol-specific, enterprise-only, or building a closed network. The unification opportunity is wide open.

---

## THE STACK TODAY

```
┌──────────────────────────────────────────────────────────────────┐
│                    AI AGENT (Claude, GPT, etc.)                  │
├──────────────────────────────────────────────────────────────────┤
│  IDENTITY & TRUST                                                │
│  → Nekuda — agent wallets + purchasing mandates                  │
│  → Basis Theory — PCI-compliant tokenization vault               │
│  → World (Worldcoin) — human verification behind agents          │
├──────────────────────────────────────────────────────────────────┤
│  AUTHORIZATION & SPENDING CONTROLS                               │
│  → Payman AI — banking automation + approval workflows           │
│  → Proxy — virtual cards with hard spend caps per agent          │
│  → AP2 (Google) — cryptographic mandates (protocol, not startup) │
├──────────────────────────────────────────────────────────────────┤
│  ROUTING & ORCHESTRATION           ← THE GAP                    │
│  → Gr4vy — payment orchestration (enterprise, alpha for agents)  │
│  → Natural — B2B agentic payment routing                         │
│  → Skyfire — crypto-native agent payment network                 │
│  → ??? — Multi-protocol routing (MPP + x402 + ACP + cards)      │
├──────────────────────────────────────────────────────────────────┤
│  PROTOCOLS                                                       │
│  → ACP (OpenAI/Stripe) — e-commerce checkout in ChatGPT         │
│  → MPP (Stripe/Tempo) — session-based streaming payments         │
│  → x402 (Coinbase) — per-request HTTP 402 micropayments          │
│  → UCP (Google/Shopify) — REST commerce with agent headers       │
├──────────────────────────────────────────────────────────────────┤
│  PROTOCOL-SPECIFIC TOOLING                                       │
│  → CrowPay — x402 integration helper                             │
│  → Settld — verify-before-release x402 gateway                   │
│  → Conway — x402 payments for agent infrastructure               │
└──────────────────────────────────────────────────────────────────┘
```

---

## STARTUPS BY LAYER

### Identity & Trust Layer

**Nekuda** — $5M seed (Madrona, Amex Ventures, Visa Ventures)
- SDK giving agents a Secure Agent Wallet to store and inject payment credentials at checkout
- Agentic Mandates: captures user purchasing intent — what the agent is allowed to buy, spending limits, required approvals
- Launch partner for Visa Intelligent Commerce
- Building ecosystem tools: Protocol Scout, Checkout.directory
- Positioned at the identity/credential layer, not routing

**Basis Theory** — $33M Series B ($50M total, Costanoa Ventures lead)
- PCI-compliant tokenization vault for securing payment credentials
- Founded by fintech veterans from Dwolla, Yodlee, Klarna
- Leading the Agentic Commerce Consortium — 20+ companies defining standards for agents as trusted buyers
- Focus: agents initiate and manage transactions without exposing raw card data
- Enterprise-grade, not developer-SDK-first

**World (Worldcoin)** — launched March 2026
- Tool to verify there's a real human behind an AI shopping agent
- Solves the "is this agent authorized by an actual person?" problem
- Identity primitive, not a payments product

---

### Authorization & Spending Controls Layer

**Payman AI** — $13.8M Series A (investors include Visa, Boost VC)
- AI that executes real banking transactions — payments, transfers, account analysis
- Creates dedicated wallets with policy rules and human approvals
- Two-sided: agents can also post tasks to a marketplace for humans to fulfill
- More "bank automation" than agent-to-API payments
- Founded 2024, Durango, CO

**Proxy** (useproxy.ai) — Virtual cards & bank accounts for AI agents
- Agents request a purchase intent → Proxy issues a locked virtual card scoped to that single transaction
- Hard spend caps (not just policy — actual card-level limits)
- MCP server integration: agents can request cards programmatically
- Card-on-File → Agent-on-File model
- Works anywhere cards are accepted (doesn't require protocol support)

---

### Routing & Orchestration Layer (THE GAP)

**Skyfire** — $9.5M (a16z CSX Fall 2024)
- Self-described "first payment network for AI agents"
- Crypto-native: uses USDC in agent-specific wallets
- Founded by ex-Ripple execs (Amir Sarhangi, Craig DeWitt)
- Agents can hold funds, send payments, trade tokens, earn yield
- **Why it's NOT the routing layer:** It's a closed payment network, not a router across protocols. Doesn't abstract MPP/x402/ACP.

**Natural** — $9.8M seed (Abstract, Human Capital; angels from Bridge, Mercury, Ramp, Vercel)
- Re-architecting the payment stack for B2B agentic workflows
- Focus: logistics, property management, procurement, healthcare, construction
- Agents source, negotiate, and pay vendors autonomously
- **Why it's NOT the routing layer:** Enterprise B2B, not a developer SDK for API-to-API agent payments.

**Gr4vy** — Payment orchestration platform (enterprise)
- Existing payment orchestration infra now adding an Agentic Orchestration Layer (currently alpha)
- Routes payments to merchant-preferred providers with fraud/AML built in
- Token vaulting with amount, frequency, duration limits
- **Why it's NOT the routing layer:** Enterprise merchant-facing, not agent-developer-facing. Multi-PSP, not multi-protocol (MPP/x402).

---

### Protocol-Specific Tooling

**CrowPay** — x402 integration helper
- "Add x402 in a few lines" — simplifies x402 for Express, Next.js, Cloudflare Workers
- x402-only. No MPP, no ACP, no card fallback.

**Settld** — Verify-before-release x402 gateway
- Escrow-like: holds payment until work is verified
- x402-only, single-protocol.

**Conway** — Agent infrastructure platform (First Round, Kleiner Perkins, BoxGroup)
- Agents spin up VMs, run frontier models, register domains, pay with USDC via x402
- Infrastructure layer, not a payments routing product.

---

## PROTOCOLS COMPARISON

| Protocol | Backers | Model | Status |
|----------|---------|-------|--------|
| **ACP** | OpenAI + Stripe | E-commerce checkout inside ChatGPT | Live (scaled back to ~12 merchants, pivoting to app-based) |
| **MPP** | Stripe + Tempo + Paradigm | Session-based streaming payments | Live since March 18, 2026, 100+ services |
| **x402** | Coinbase + Cloudflare | Per-request HTTP 402 micropayments | Live since May 2025, 500K weekly txns |
| **UCP** | Google + Shopify | REST commerce APIs with agent headers | Early, focused on extending existing e-commerce |
| **AP2** | Google Cloud | Cryptographic authorization mandates | Announced, 60+ partners, no live product |

---

## WHY THE GAP EXISTS — AND WHY NOBODY HAS FILLED IT

> **The routing layer — where an agent calls `fetch()` and the SDK auto-detects whether the endpoint speaks MPP, x402, ACP, or needs a card — remains COMPLETELY UNBUILT.**

Why each existing player fails to be the routing layer:

| Startup | What they are | Why they're NOT the routing layer |
|---------|--------------|----------------------------------|
| **Skyfire** | Closed crypto payment network | Own rail, doesn't abstract across protocols |
| **Natural** | B2B enterprise payments | Not a developer SDK, vertical-specific |
| **Gr4vy** | Merchant payment orchestration | Enterprise/merchant-facing, not agent-developer-facing |
| **Nekuda** | Identity & credentials | Credential vault, not payment routing |
| **Proxy** | Virtual card issuance | Card-only, no protocol abstraction |
| **CrowPay** | x402 helper | Single-protocol only |
| **Settld** | x402 escrow | Single-protocol only |
| **Conway** | Agent infrastructure | Uses x402 as a rail, doesn't abstract over it |
| **Payman AI** | Banking automation | Traditional banking, not protocol-aware |
| **Basis Theory** | Tokenization vault | Security layer, not routing |

**The product that needs to exist:**
```typescript
// ONE LINE. Auto-detects protocol. Routes optimally. Handles 402 challenges.
const response = await agent.fetch('https://api.example.com/data');
```

Three incompatible protocols. Trillion-dollar backers. No unification layer. First-mover window is NOW.

---

## ACQUISITION TARGETS

- **Stripe/Tempo** — Routing layer that defaults to MPP makes MPP the standard. They can't build x402 support themselves (it's Coinbase's protocol). Acquiring neutral middleware is politically easier.
- **Coinbase** — x402 adoption is weak (~$28K/day real volume, dropped 92% in 3 months). If Stripe acquires the routing layer and deprioritizes x402, Coinbase loses.
- **Dual-track leverage** — Stripe knows Coinbase is interested. Coinbase knows Stripe is interested. Competition drives price.

---

## PRODUCT NAME OPTIONS

### Tier 1 — Strongest

| Name | Why it works |
|------|-------------|
| **Paymux** | "Multiplexer" — technical, developer-native, implies combining multiple payment signals into one channel. `import { Paymux } from 'paymux'` |
| **Payway** | Short, implies routing ("which way?"). Evokes gateway + pathway. Clean npm potential. |
| **Railswitch** | Directly references payment rails + switching between them. Instantly communicates the value prop. |
| **Omnipay** | "All payments, one SDK." Simple, memorable, authoritative. |

### Tier 2 — Strong

| Name | Why it works |
|------|-------------|
| **Conduit** | Single pipe channeling all payment protocols. Clean, abstract, acquisition-friendly. |
| **Nexapay** | "Nexus" + "pay." Connection point. Sounds like it belongs in a Stripe product suite. |
| **Meshpay** | Interconnection of protocols. Networking connotation fits the routing metaphor. |
| **Clearway** | "Clearing" (financial term) + "way" (routing). Institutional enough to keep post-acquisition. |

### Tier 3 — Bold / Crypto-Leaning

| Name | Why it works |
|------|-------------|
| **402.pay** | Literally the HTTP status code the entire ecosystem is built on. Memorable. Conversation starter. |
| **Agora** | Ancient Greek marketplace. Short, elegant, implies commerce. Risk: overused. |
| **Payroute** | Extremely literal. Zero ambiguity about what it does. |

### Top Pick: **Paymux**
Short. Technically meaningful (multiplexing payment protocols). Unique. Works as npm package, domain, and import statement. Same developer-first energy as Stripe, Privy, mppx.

---

## IMPLEMENTATION STATUS (v0.2.0)

### Audit Results Applied

Deep audit of the MPP code path found and fixed **4 critical, 8 high, 7 medium** issues across client, server, sessions, and spending enforcement.

**Critical fixes:**
- C1+C2: `SpendingReservation` token system — `check()` returns an opaque token, `record(token, actualAmount)` releases the exact reserved amount from pending and records the actual. Prevents spending drift when server changes price between probe and payment.
- C3: Sessions read `lastPaymentResult` atomically from the parent client instead of comparing `spending.history.length` before/after fetch. Safe with concurrent sessions and ring buffer wrapping.
- C4: Session budget overrun warnings when a payment pushes past the remaining budget.

**Key architectural changes:**
- `SpendingEnforcer.check()` now returns `SpendingReservation` (exported type) and accepts `skipPerRequest` flag
- `PayMuxClient` exposes `lastPaymentResult: PaymentResult | null` for session tracking
- `MppTimeoutError` (exported class) signals that the mppx payment may still complete in the background — callers should NOT release the spending reservation
- x402 payment requests use `AbortController` instead of `Promise.race` — timeouts actually cancel the HTTP request
- Server factory cache: 1-hour TTL, max 50 entries, 64-bit hash (FNV-1a + DJB2) with full config comparison on hit
- Expired sessions auto-close and release budget back to the global spending enforcer

### Remaining Known Issues (deferred)

| Issue | Severity | Description |
|-------|----------|-------------|
| M4 | Medium | MPP challenge regex `(\w+)="([^"]*)"` doesn't handle escaped quotes in non-base64 params like `realm` |
| M9 | Medium | Non-USD fiat currencies (EUR, GBP) are treated as equivalent to USD in spending limit comparisons |
| M11 | Medium | x402 verify-then-settle has a TOCTOU gap where EIP-3009 authorization can expire between steps |

### What's Next

- **Visa TAP integration** — Generate TAP-compliant signatures (RFC 9421 / Ed25519) when routing through card rails. Integrate `mpp-card` npm package for Visa card-based MPP support.
- **Card payments** — Currently throws "Card payments ship in a future release". Requires Visa TAP or Stripe card integration.
- **Privy / Coinbase wallets** — Only `wallet.privateKey` supported. Session-based wallets would require changes to the signing flow.
- **Rate limiting** — Server middleware needs per-IP / per-agent rate limiting (noted as TODO in `paymux-server.ts`).

---

## SOURCES

- [Nekuda](https://nekuda.ai/)
- [Basis Theory](https://basistheory.com/)
- [Natural](https://www.natural.co/)
- [Skyfire](https://skyfire.xyz/)
- [Gr4vy Agentic Payments](https://gr4vy.com/posts/agentic-payments-in-2026-what-merchants-need-to-understand-and-prepare-for/)
- [Proxy](https://www.useproxy.ai/)
- [Payman AI](https://paymanai.com/)
- [Conway](https://www.conway.ai/)
- [CrowPay](https://www.crowpay.ai/)
- [Agentic Commerce Protocol (ACP)](https://openai.com/index/buy-it-in-chatgpt/)
- [Stripe Agentic Commerce Suite](https://stripe.com/blog/agentic-commerce-suite)
- [World Agent Verification](https://techcrunch.com/2026/03/17/world-launches-tool-to-verify-humans-behind-ai-shopping-agents/)
- [Agentic Payments Map - Fintech Brain Food](https://www.fintechbrainfood.com/p/the-agentic-payments-map)
- [Agentic Commerce Landscape - Rye](https://rye.com/blog/agentic-commerce-startups)
- [Privacy.com AI Agent Payments Compared](https://www.privacy.com/blog/payment-solutions-ai-agents-2026-compared)

---

## VISA TRUSTED AGENT PROTOCOL (TAP) — REFERENCE

**GitHub:** https://github.com/visa/trusted-agent-protocol

**What it is:** Open framework (not proprietary) for verifying AI agent identity at the CDN/merchant level. Built on RFC 9421 HTTP Message Signatures with Ed25519 cryptography.

**Architecture (5 services):**
- TAP Agent — the AI agent making requests
- Merchant Frontend — serves the merchant site/API
- CDN Proxy — performs 7-step cryptographic verification at the edge
- Merchant Backend — processes verified requests
- Agent Registry — maintains agent identity + public key tables with key rotation support

**How it works:**
- Each agent request carries two HTTP headers: `Signature-Input` (keyId, created timestamp, nonce, algorithm, covered components `@authority` and `@path`) and `Signature` (base64-encoded Ed25519 signature)
- CDN Proxy verification: temporal validation → replay prevention (1-hour nonce TTL) → domain binding → Ed25519 signature verification
- Failed verification returns 403 Forbidden

**Partners:** Microsoft, Nuvei, Shopify, Stripe, Worldpay, Adyen, Checkout.com, Fiserv, Circle, Webflow, Cloudflare

**Web Bot Auth (shared foundation):** TAP and Mastercard Agent Pay both build on Web Bot Auth, co-developed with Cloudflare. Uses RFC 9421 + Ed25519. A `tag` field differentiates browsing (`agent-browser-auth`) from purchasing (`agent-payer-auth`). Cloudflare verifies at the CDN level.

**Card-Based MPP (March 18, 2026):** Visa released a Card-Based MPP Specification (processor-agnostic, at paymentauth.org) + npm SDK `mpp-card`. Agents use MPP session workflows but settle on Visa card rails.

**Visa Agentic Ready programme (21 banks):** Alpha Bank, Banca Transilvania, Bank Leumi, Bank of Cyprus, Bank of Valletta, Barclays, CAL, Commerzbank, Cornercard, DZ Bank, Erste Bank, Eurobank, HSBC UK, MAX, Millennium BCP, Nationwide, Nexi Group, Piraeus Bank, Raiffeisen Bank, Revolut, Santander.

**PayMux integration notes:**
- Generate TAP-compliant signatures (RFC 9421 / Ed25519) when routing through card rails
- Integrate `mpp-card` npm package for Visa card-based MPP support
- Support Web Bot Auth header format for CDN-level verification
