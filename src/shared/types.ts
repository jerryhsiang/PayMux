/**
 * Supported payment protocols
 */
export type Protocol = 'x402' | 'mpp' | 'card';

/**
 * Supported blockchain networks (CAIP-2 format for EVM, string for others)
 */
export type Chain =
  | 'base'
  | 'base-sepolia'
  | 'polygon'
  | 'solana'
  | `eip155:${number}`
  | `solana:${string}`
  | string;

/**
 * Receipt from an x402 payment — signed EIP-712 payment proof
 */
export interface X402Receipt {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
}

/**
 * Receipt from an MPP payment — session-based payment confirmation
 */
export interface MppReceipt {
  status: 'success';
  method: string;
  reference: string;
  timestamp: string;
  externalId?: string;
}

/**
 * Union of all protocol-specific receipt types
 */
export type PaymentReceipt = X402Receipt | MppReceipt;

/**
 * Result of a completed payment
 */
export interface PaymentResult {
  protocol: Protocol;
  /** Raw amount string from the server (may be base units for x402/MPP with token addresses) */
  amount: string;
  currency: string;
  /**
   * Amount converted to USD for spending tracking and display.
   *
   * For x402: base units converted via token decimals (e.g., "10000" -> 0.01 for 6-decimal USDC)
   * For MPP with token address currency: same base-unit conversion
   * For MPP with fiat currency (e.g., "USD"): same as parseFloat(amount)
   *
   * CRITICAL: Always use this field for spending calculations, NOT parseFloat(amount).
   * parseFloat(amount) on base units would treat $0.01 as $10,000.
   */
  amountUsd?: number;
  transactionHash?: string;
  /**
   * Protocol-specific receipt data.
   *
   * - x402: `{ scheme: string; networkId: string; payload: string }` — the signed EIP-712 payment proof
   * - mpp: `{ sessionId: string; invoice?: string }` — the MPP session receipt
   * - card: `{ chargeId: string; last4: string }` — the card charge confirmation (future)
   */
  receipt?: PaymentReceipt;
  settledAt?: number;
}

/**
 * Payment requirements extracted from a 402 response
 */
export interface PaymentRequirement {
  protocol: Protocol;
  /** Raw amount from the server (base units for x402, USD for MPP) */
  amount: string;
  currency: string;
  /**
   * Amount converted to USD for spending limit comparison.
   * For x402: base units converted via token decimals (e.g., "10000" -> 0.01 for USDC)
   * For MPP with token address currency: base units converted via token decimals
   * For MPP with fiat currency (e.g., "USD"): same as parseFloat(amount)
   * This is what the SpendingEnforcer checks against perRequest/perDay limits.
   */
  amountUsd?: number;
  recipient?: string;
  chain?: Chain;
  resource?: string;

  // ── x402-specific fields ──────────────────────────────────────
  /** x402: CAIP-2 network identifier (e.g. "eip155:8453") */
  network?: string;
  /** x402: Recipient wallet address */
  payTo?: string;
  /** x402: Payment scheme — "exact" or "attest" */
  scheme?: string;
  /** x402: Maximum amount the server will charge (may differ from `amount`) */
  maxAmountRequired?: string;
  /** x402: Token symbol (e.g. "USDC") */
  asset?: string;

  // ── MPP-specific fields ───────────────────────────────────────
  /** MPP: Challenge identifier from the WWW-Authenticate header */
  challengeId?: string;
  /** MPP: Accepted payment methods (e.g. ["crypto", "card"]) */
  paymentMethods?: string[];

  // ── Raw data ──────────────────────────────────────────────────
  /** Raw parsed data from the 402 response (protocol-specific shape) */
  raw?: unknown;
}

/**
 * Wallet configuration — how PayMux signs payments
 */
export interface WalletConfig {
  /** Direct private key (hex string) */
  privateKey?: `0x${string}`;

  /** Privy embedded wallet */
  privy?: {
    walletId: string;
  };

  /** Coinbase Agentic Wallet */
  coinbase?: {
    agentWalletId: string;
  };
}

/**
 * Card configuration — for card-based payments (week 2+)
 */
export interface CardConfig {
  stripe?: {
    customerId: string;
  };
}

/**
 * Spending limits
 */
export interface SpendingLimits {
  /** Maximum amount per single request (USD) */
  perRequest?: number;
  /** Maximum amount per session (USD) — week 2 */
  perSession?: number;
  /** Maximum amount per rolling 24-hour period (USD) */
  perDay?: number;
  /** Amount above which human approval is required (USD) — week 8 */
  requireApproval?: number;
}

/**
 * Charge options for server middleware
 */
export interface ChargeOptions {
  /** Amount to charge in specified currency */
  amount: number;
  /** Currency code (default: 'USD') */
  currency?: string;
  /** Description shown to paying agent */
  description?: string;
  /** Maximum timeout for payment settlement (seconds) */
  maxTimeoutSeconds?: number;
}
