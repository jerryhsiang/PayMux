import type {
  WalletConfig,
  CardConfig,
  SpendingLimits,
  Protocol,
} from '../shared/types.js';
import type { PayMuxLogger } from './logger.js';

/**
 * Retry configuration for transient network failures.
 */
export interface RetryConfig {
  /** Max number of retries (default: 2) */
  maxRetries?: number;
  /** Base delay in ms before first retry (default: 1000). Doubles each retry. */
  baseDelayMs?: number;
  /** HTTP status codes to retry on (default: [502, 503, 504]) */
  retryableStatusCodes?: number[];
  /** HTTP methods to retry (default: ['GET', 'HEAD']). Other methods are never retried. */
  retryMethods?: string[];
}

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
  /** Enable debug logging (uses built-in [paymux] formatter) */
  debug?: boolean;
  /**
   * Custom logger for structured, production-observable output.
   *
   * - Provide an object with `debug`, `info`, `warn`, `error` methods
   *   to receive structured data (e.g. for Datadog, Pino, Winston).
   * - Set to `false` to disable all logging (even when `debug: true`).
   * - Omit to use the default behavior: logs to console when `debug: true`,
   *   silent otherwise.
   */
  logger?: PayMuxLogger | false;
  /** Retry configuration for transient failures. Set to false to disable. */
  retry?: RetryConfig | false;
  /** Timeout configuration for network calls (milliseconds) */
  timeouts?: {
    /** Timeout for the initial 402 protocol-detection probe (default: 10000ms / 10s) */
    probeMs?: number;
    /** Timeout for payment settlement calls (default: 30000ms / 30s) */
    paymentMs?: number;
  };
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
  /**
   * @internal Skip global spending limit checks. Used by PayMuxSession to avoid
   * double-charging — the session's full budget is already reserved globally.
   */
  skipSpendingCheck?: boolean;
}
