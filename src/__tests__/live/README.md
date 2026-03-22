# Live Tests — Real Blockchain Transactions

These tests make REAL payments on REAL chains. They require funded wallets and cost actual tokens.

## Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp src/__tests__/live/.env.example src/__tests__/live/.env
   ```

2. Fund your test wallet:
   - **Testnet:** Get Base Sepolia USDC from a faucet
   - **Mainnet:** Send USDC to your wallet on Base

3. Run live tests:
   ```bash
   # Testnet only (free, use faucet USDC)
   npx vitest run src/__tests__/live/x402-testnet.test.ts

   # Mainnet (costs real USDC!)
   npx vitest run src/__tests__/live/x402-mainnet.test.ts

   # MPP (requires Tempo testnet tokens)
   npx vitest run src/__tests__/live/mpp-testnet.test.ts

   # All live tests
   npx vitest run src/__tests__/live/
   ```

## Costs

| Test | Chain | Cost per run |
|------|-------|-------------|
| x402-testnet | Base Sepolia | Free (testnet USDC) |
| x402-mainnet | Base | ~$0.05 real USDC |
| mpp-testnet | Tempo testnet | Free (testnet PathUSD) |

## These are NOT in CI

Live tests are excluded from `npm test` because they:
- Require funded wallets (private keys in .env)
- Cost real money on mainnet
- Depend on external services (facilitator, blockchain)
- Are non-deterministic (tx confirmation times)
