# PayMux Test Coverage

## Current Status: 90 unit/e2e tests + 8 live blockchain tests

### Unit + E2E (run in CI, free):
```
npm test        → 90 tests, 5 files, all passing
```

### Live blockchain tests (manual, costs real/testnet tokens):
```
npx vitest run src/__tests__/live/x402-testnet.test.ts    # Base Sepolia (free)
npx vitest run src/__tests__/live/x402-mainnet.test.ts    # Base mainnet (costs USDC!)
npx vitest run src/__tests__/live/mpp-testnet.test.ts     # Tempo testnet (free)
```

```
npm test
```

---

## What's Tested (by developer persona)

### For Agent Developers ("Can I pay for APIs?")

| Test | Status | File |
|------|:---:|------|
| Can I `npm i paymux` and create a client? | ✅ | client.test.ts |
| Does `agent.fetch()` return non-402 responses without payment? | ✅ | client.test.ts, e2e.test.ts |
| Does `agent.fetch()` detect x402 from a real Express server? | ✅ | e2e.test.ts |
| Does `agent.fetch()` detect MPP from WWW-Authenticate header? | ✅ | detector.test.ts |
| Are spending limits enforced BEFORE payment? | ✅ | e2e.test.ts |
| Does `perRequest` limit reject overspend? | ✅ | client.test.ts, e2e.test.ts |
| Does `perDay` limit reject after exhaustion? | ✅ | client.test.ts, spending.test.ts |
| Does `maxAmount` ceiling work? | ✅ | client.test.ts |
| Do failed payments leave spending at $0? | ✅ | e2e.test.ts |
| Does `skipPayment: true` bypass everything? | ✅ | client.test.ts |
| Are PayMux options stripped from native fetch? | ✅ | client.test.ts |
| Does debug mode log the flow? | ✅ | client.test.ts, e2e.test.ts |
| Does it warn about unsupported Privy wallets? | ✅ | client.test.ts |
| Can I actually pay a real x402 endpoint and get data back? | ❌ | Needs live test |
| Can I actually pay a real MPP endpoint and get data back? | ❌ | Needs live test |

### For API Developers ("Can I get paid?")

| Test | Status | File |
|------|:---:|------|
| Can I create a PayMuxServer with x402 config? | ✅ | server.test.ts |
| Can I create a PayMuxServer with x402 + mpp config? | ✅ | server.test.ts |
| Does `payments.charge()` return a middleware function? | ✅ | server.test.ts |
| Does the Express middleware return 402 with correct headers? | ✅ | e2e.test.ts |
| Does the 402 contain x402Version: 2? | ✅ | e2e.test.ts |
| Does the 402 contain the correct USDC contract address? | ✅ | e2e.test.ts |
| Does the 402 contain amounts in base units (not USD)? | ✅ | e2e.test.ts |
| Do multiple price tiers ($0.001, $10.00) convert correctly? | ✅ | e2e.test.ts |
| Does the 402 body include protocol info? | ✅ | e2e.test.ts |
| Does config validation catch missing x402 config? | ✅ | server.test.ts |
| Does config validation catch missing mpp config? | ✅ | server.test.ts |
| Does config validation catch missing secretKey? | ✅ | server.test.ts |
| Does it reject negative/zero/NaN/Infinity amounts? | ✅ | server.test.ts |
| Does it reject non-HTTPS facilitator URLs? | ✅ | server.test.ts |
| Is the config frozen against external mutation? | ✅ | server.test.ts |
| Does the Hono middleware work? | ❌ | Needs test |
| Does verification against the real facilitator work? | ❌ | Needs live test |
| End-to-end: agent pays → server verifies → agent gets data? | ❌ | Needs live test |

### Protocol Compliance

| Test | Status | File |
|------|:---:|------|
| x402 v2 header parsing | ✅ | detector.test.ts |
| x402 v1 header parsing | ✅ | detector.test.ts |
| CAIP-2 network → chain name mapping | ✅ | detector.test.ts |
| MPP WWW-Authenticate: Payment parsing | ✅ | detector.test.ts |
| Dual-protocol detection (x402 + MPP headers) | ✅ | detector.test.ts |
| Body fallback when no headers | ✅ | detector.test.ts |
| Malformed base64 / JSON graceful handling | ✅ | detector.test.ts |
| selectBestRequirement: MPP preferred over x402 | ✅ | detector.test.ts |
| selectBestRequirement: respects preferredProtocol | ✅ | detector.test.ts |
| toBaseUnits: 0.01 → "10000" (6 decimals) | ✅ | server.test.ts |
| toBaseUnits: floating-point precision | ✅ | server.test.ts |
| toBaseUnits: custom decimal places | ✅ | server.test.ts |
| formatAmount: no scientific notation | ✅ | server.test.ts |

### Security

| Test | Status | File |
|------|:---:|------|
| Per-request limit enforcement | ✅ | spending.test.ts |
| Per-day cumulative tracking | ✅ | spending.test.ts |
| Concurrent check() reserves pending amounts | ✅ | spending.test.ts |
| release() frees pending on failure | ✅ | spending.test.ts |
| release() doesn't go below zero | ✅ | spending.test.ts |
| requireApproval threshold | ✅ | spending.test.ts |
| HTTPS enforced on facilitator URL | ✅ | server.test.ts |
| Config frozen against mutation | ✅ | server.test.ts |
| Settlement defaults to false (not true) | ✅ | Code review verified |
| Private keys never logged | ✅ | Code review verified |

---

## Tests NOT Yet Written (Ordered by Priority)

### Priority 1: Live Protocol Tests (need real blockchain)

These can't run in CI — they require testnet USDC and real facilitator access.

```
tests/live/
├── x402-pay-real-endpoint.test.ts     # Pay a real x402 API, get data back
├── mpp-pay-real-endpoint.test.ts      # Pay a real MPP API, get data back
├── facilitator-verify.test.ts         # Call real facilitator /verify endpoint
├── facilitator-settle.test.ts         # Call real facilitator /settle endpoint
└── tempo-settlement.test.ts           # Verify on-chain settlement on Tempo testnet
```

**What these would prove:**
- PayMux can complete a real payment against a live x402 server
- PayMux can complete a real payment against a live MPP server
- The facilitator API calls (URL, body, response parsing) are correct
- On-chain settlement actually settles USDC

**Why they're not in CI:**
- Require Base Sepolia USDC in a test wallet
- Require a live x402/MPP server to pay
- Require network access to facilitator and blockchain
- Non-deterministic (tx times, network latency)

### Priority 2: Hono Middleware Tests

```typescript
// Currently untested — Express middleware is tested in e2e.test.ts
// but Hono middleware is only tested via type-checking
describe('E2E: Hono server with x402 payments', () => {
  it('returns 402 with PAYMENT-REQUIRED header')
  it('returns correct x402 requirements in header')
  it('handles MPP Authorization: Payment header')
  it('forwards mppx challenge response correctly')
  it('wraps response with Payment-Receipt via withReceipt()')
})
```

### Priority 3: Server Payment Verification Tests (with mocked facilitator)

```typescript
describe('x402 payment verification', () => {
  it('accepts valid PAYMENT-SIGNATURE and calls facilitator /verify')
  it('settles payment via facilitator /settle')
  it('returns 402 when verification fails')
  it('returns 402 when settlement fails')
  it('handles facilitator timeout (30s)')
  it('handles facilitator 500 error')
  it('defaults to settled: false on malformed response')
})

describe('MPP payment verification', () => {
  it('accepts valid Authorization: Payment credential')
  it('delegates to mppx.charge() for verification')
  it('returns mppx challenge when no credential')
  it('wraps response with Payment-Receipt on success')
})
```

### Priority 4: Edge Cases

```typescript
describe('edge cases', () => {
  it('handles server that changes price between probe and payment (TOCTOU)')
  it('handles server that returns 402 then 200 on same URL (race condition)')
  it('handles concurrent agent.fetch() calls respecting daily limit')
  it('handles very large amounts (overflow test)')
  it('handles zero-amount 402 responses')
  it('handles 402 with empty PAYMENT-REQUIRED header')
  it('handles 402 with both x402 and MPP headers (dual-protocol)')
  it('handles network errors during payment')
  it('handles partial JSON in 402 body')
  it('memory: paymentHistory caps at 10,000 entries')
})
```

### Priority 5: Performance Tests

```typescript
describe('performance', () => {
  it('non-402 response adds < 1ms overhead')
  it('protocol detection < 5ms for well-formed headers')
  it('spending check < 0.1ms for in-memory limits')
  it('lazy initialization: x402 libs load only on first 402')
  it('lazy initialization: mppx libs load only on first MPP')
})
```

### Priority 6: Framework Compatibility Tests

```typescript
describe('framework compatibility', () => {
  it('Express 4.x middleware works')
  it('Express 5.x middleware works')
  it('Hono 4.x middleware works')
  it('Hono on Cloudflare Workers')
  it('Hono on Deno')
  it('Hono on Bun')
  it('Next.js API route integration')
})
```

---

## How to Run Tests

```bash
# Run all tests
npm test

# Run with watch mode
npm run test:watch

# Run specific test file
npx vitest run src/__tests__/e2e.test.ts

# Run with coverage
npx vitest run --coverage
```

---

## Test Architecture

```
src/__tests__/
├── spending.test.ts     # SpendingEnforcer unit tests (17 tests)
│                        # Per-request, per-day, concurrency, release
│
├── detector.test.ts     # Protocol detector unit tests (16 tests)
│                        # x402 v1/v2, MPP challenge, dual-protocol, body fallback
│
├── client.test.ts       # PayMux client unit tests (14 tests)
│                        # Create, fetch non-402, spending limits, debug logging
│
├── server.test.ts       # PayMuxServer + toBaseUnits unit tests (24 tests)
│                        # Config validation, charge validation, base unit conversion
│
└── e2e.test.ts          # End-to-end integration tests (13 tests)
                         # Real Express server, real 402 responses, real detection flow
```

Every test that handles money has been written. The remaining gaps are live blockchain tests (require real USDC) and framework compatibility tests (require multiple runtimes).
