# PayMux Cloudflare Worker Template

Deploy a paid API with PayMux and Cloudflare Workers. Accepts payments from any AI agent via x402.

## Quick Start

1. Clone this template
2. Set your wallet address in `wrangler.toml`
3. Install dependencies and deploy:

```bash
npm install
npm run type-check
npm run deploy
```

Your API now accepts payments from any PayMux-enabled agent.

## Endpoints

| Endpoint | Price | Description |
|----------|-------|-------------|
| `/` | Free | API info page |
| `/api/joke` | $0.01 | Get a random joke |
| `/api/data` | $0.05 | Get premium data |

## How It Works

This template uses [PayMux](https://paymux.dev) server middleware to gate endpoints behind payment. When an AI agent requests a paid endpoint:

1. Your API returns HTTP 402 with payment requirements
2. The agent pays via x402 (USDC on Base)
3. PayMux verifies the payment
4. Your API returns the resource

## Configuration

Edit `wrangler.toml`:

```toml
[vars]
RECIPIENT_ADDRESS = "0xYourWalletAddress"
CHAIN = "base-sepolia"  # or "base" for mainnet
```

### Secrets

For any future secrets (API keys, signing keys, etc.), use `wrangler secret put` rather than storing them in `wrangler.toml`:

```bash
wrangler secret put MY_SECRET_KEY
```

This ensures secrets are encrypted and not checked into source control.

## Powered by PayMux

[PayMux](https://paymux.dev) — The easiest way to make your API agent-payable.
