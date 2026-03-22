/**
 * Retry a fetch call on transient (5xx) failures.
 *
 * - Only retries on HTTP 5xx status codes (server errors).
 * - 4xx responses are real errors and are returned immediately.
 * - Network/timeout errors (thrown exceptions) are NOT retried — they propagate.
 * - Max 2 retries with a 1 second delay between attempts.
 */
export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  maxRetries: number = 2,
  delayMs: number = 1000
): Promise<Response> {
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(input, init);

    // 5xx → transient server error, eligible for retry
    if (response.status >= 500 && response.status < 600 && attempt < maxRetries) {
      lastResponse = response;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    // 2xx, 3xx, 4xx, or final 5xx attempt — return as-is
    return response;
  }

  // Should not be reached, but satisfy TypeScript
  return lastResponse!;
}

/**
 * USDC has 6 decimal places. Convert a human-readable USD amount
 * to the base unit string required by the x402 protocol.
 *
 * Example: 0.01 USD → "10000" (0.01 * 10^6)
 * Example: 1.50 USD → "1500000" (1.50 * 10^6)
 *
 * The x402 spec requires amounts in the token's smallest unit.
 * USDC uses 6 decimals on all supported chains (Base, Polygon, Ethereum).
 */
const USDC_DECIMALS = 6;

/**
 * Convert a human-readable amount (e.g. 0.01) to base units string (e.g. "10000")
 * for the x402 protocol. Uses BigInt arithmetic to avoid floating-point errors.
 */
export function toBaseUnits(amount: number, decimals: number = USDC_DECIMALS): string {
  // Use string manipulation to avoid floating-point multiplication errors
  // e.g. 0.1 * 1000000 = 100000.00000000001 in JS
  const parts = amount.toFixed(decimals).split('.');
  const whole = parts[0];
  const frac = (parts[1] ?? '').padEnd(decimals, '0').slice(0, decimals);
  const raw = whole + frac;
  // Remove leading zeros but keep at least "0"
  return raw.replace(/^0+/, '') || '0';
}

/**
 * Format a numeric amount as a human-readable string without scientific notation.
 *
 * Used for display/logging purposes only — NOT for the x402 protocol wire format.
 * For wire format, use toBaseUnits() instead.
 */
export function formatAmount(amount: number): string {
  const str = amount.toString();
  if (str.includes('e') || str.includes('E')) {
    const decimalPlaces = Math.min(20, Math.max(0, -Math.floor(Math.log10(Math.abs(amount))))) + 6;
    return amount.toFixed(Math.min(decimalPlaces, 20));
  }
  const parts = str.split('.');
  if (parts.length === 2) {
    return amount.toFixed(parts[1].length);
  }
  return str;
}
