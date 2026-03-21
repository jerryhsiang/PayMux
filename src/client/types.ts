import type {
  WalletConfig,
  CardConfig,
  SpendingLimits,
  Protocol,
} from '../shared/types.js';

/**
 * Configuration for creating a PayMux client
 */
export interface PayMuxConfig {
  /** Wallet for crypto payments (x402, MPP) */
  wallet?: WalletConfig;
  /** Card credentials for card-based payments */
  card?: CardConfig;
  /** Spending limits */
  limits?: SpendingLimits;
  /** Protocol preference order (default: auto-detect) */
  preferProtocol?: Protocol[];
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Options for agent.fetch() — extends standard RequestInit
 */
export interface PayMuxFetchOptions extends RequestInit {
  /** Override spending limit for this request */
  maxAmount?: number;
  /** Force a specific protocol */
  protocol?: Protocol;
  /** Skip payment (useful for testing) */
  skipPayment?: boolean;
}
