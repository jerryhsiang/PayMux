# PayMux Quickstart

Make your first agent payment in 5 minutes.

## Quick Demos (no wallet needed)

### x402 Demo

```bash
cd examples/quickstart
npm install
npm run demo
```

This runs a paid API and an agent in the same process, showing:
- Free endpoints pass through with zero overhead
- Paid endpoints return 402 with x402 payment requirements
- PayMux auto-detects the protocol
- Spending limits block overspend before payment
- Clear error messages at every step

### MPP Demo

```bash
npm run mpp-demo
```

Shows the MPP (Micropayments Protocol / Stripe/Tempo) flow:
- Server returns 402 with `WWW-Authenticate: Payment` challenge headers
- PayMux auto-detects MPP and extracts amount, currency, and method
- Spending limits enforce budgets before any payment attempt
- Dual-protocol detection when a server supports both MPP and x402
- Side-by-side comparison of MPP vs x402 headers and flow

## Full Demo (with testnet payments)

### 1. Get testnet USDC

You need a wallet with USDC on Base Sepolia (free testnet tokens):

1. **Create a wallet** — MetaMask, Coinbase Wallet, or any EVM wallet
2. **Get Base Sepolia ETH** — [Coinbase Faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
3. **Get testnet USDC** — Bridge or faucet (check [Base Sepolia docs](https://docs.base.org/docs/tools/faucets))
4. **Export your private key** — you'll need it for the agent

### 2. Start the paid API server

```bash
cd examples/quickstart
npm install
npm run server
```

You'll see:
```
🚀 PayMux Quickstart Server running!

   Free:  http://localhost:3001/api/time
   Paid:  http://localhost:3001/api/joke  ($0.01)

Try it:
   curl http://localhost:3001/api/time     # Free — works
   curl http://localhost:3001/api/joke     # Paid — returns 402
```

### 3. Run the paying agent

In a new terminal:

```bash
PRIVATE_KEY=0xYourPrivateKey npm run agent
```

You'll see:
```
🤖 PayMux Agent starting...

── Step 1: Fetching free endpoint ──
[paymux] [>] GET http://localhost:3001/api/time
[paymux] [<] 200 (no payment required)
Result: { time: '2026-03-22T...' }
Spending so far: $0.00

── Step 2: Fetching paid endpoint ($0.01) ──
[paymux] [>] GET http://localhost:3001/api/joke
[paymux] [<] 402 Payment Required — detecting protocol...
[paymux]   Protocol: x402 | Amount: $0.010000 (raw: 10000 0x036C...)
[paymux] [ok] Paid $0.010000 via x402 | tx: 0x...
Result: { joke: '...', price: '$0.01', paidVia: 'paymux x402' }
Spending so far: $0.010000

── Spending Summary ──
  Total spent:     $0.010000
  Daily remaining: $0.99
  Payments made:   1
  Last payment:    10000 USDC via x402
  Transaction:     0x...
```

## How it works

### Server side (5 lines)

```typescript
import { PayMuxServer } from 'paymux/server';

const payments = PayMuxServer.create({
  accept: ['x402'],
  x402: { recipient: '0x...', chain: 'base-sepolia' },
});

app.get('/api/joke',
  payments.charge({ amount: 0.01, currency: 'USD' }),
  (req, res) => res.json({ joke: '...' })
);
```

### Agent side (5 lines)

```typescript
import { PayMux } from 'paymux';

const agent = PayMux.create({
  wallet: { privateKey: '0x...' },
  limits: { perRequest: 0.10, perDay: 1.00 },
});

const response = await agent.fetch('http://localhost:3001/api/joke');
const data = await response.json(); // { joke: '...', price: '$0.01' }
```

## MPP — Real Payments (Tempo testnet)

The `npm run mpp-demo` command above shows MPP detection without a wallet.
To make real MPP payments on the Tempo testnet:

```bash
# Install mppx CLI and create a testnet account (auto-funded)
npm i -g mppx
mppx account create

# Use the account's private key
PRIVATE_KEY=0x... npm run agent
```

Server config for MPP:

```bash
# Generate your MPP secret key once:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Add it to your environment:
export MPP_SECRET_KEY="<the generated key>"
```

```typescript
const payments = PayMuxServer.create({
  accept: ['x402', 'mpp'],
  x402: { recipient: '0x...', chain: 'base-sepolia' },
  mpp: {
    secretKey: process.env.MPP_SECRET_KEY!,
    tempoRecipient: '0x...',
    testnet: true,
  },
});
```

> **Note:** The `secretKey` must persist across server restarts. Never use `crypto.randomBytes()` inline — all in-flight payment challenges become invalid if the key changes. See [MPP Configuration](../../README.md#mpp-configuration) in the main README for details.

The agent code is identical — PayMux auto-detects the protocol.
