/**
 * Token decimal places for converting base units to human-readable amounts.
 *
 * x402 sends amounts in base units (e.g., "10000" for $0.01 USDC with 6 decimals).
 * Spending limits are in USD. This module converts between the two.
 */

/** Known token decimals by asset address (lowercase) */
const TOKEN_DECIMALS: Record<string, number> = {
  // USDC on all chains — 6 decimals
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, // Base mainnet
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': 6, // Base Sepolia
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 6, // Polygon mainnet
  '0x41e94eb71ef8c9863e91b9c684d4e1b9f5b1eea5': 6, // Polygon Amoy
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // Ethereum mainnet
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': 6, // Ethereum Sepolia
  // PathUSD on Tempo chain — 6 decimals (used by MPP/mppx)
  '0x20c0000000000000000000000000000000000000': 6,
};

/** Human-readable token names by address (lowercase) for debug output */
const TOKEN_NAMES: Record<string, string> = {
  '0x20c0000000000000000000000000000000000000': 'PathUSD',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC (Base)',
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': 'USDC (Base Sepolia)',
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC (Polygon)',
  '0x41e94eb71ef8c9863e91b9c684d4e1b9f5b1eea5': 'USDC (Polygon Amoy)',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC (Ethereum)',
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': 'USDC (Ethereum Sepolia)',
};

/** Default decimals when token is unknown (USDC = 6) */
const DEFAULT_DECIMALS = 6;

/**
 * Convert a base-unit amount string to a human-readable USD amount.
 *
 * Example: "10000" with 6 decimals → 0.01
 * Example: "1500000" with 6 decimals → 1.50
 * Example: "0" → 0
 *
 * This is the inverse of server/utils.ts toBaseUnits().
 */
export function fromBaseUnits(baseUnits: string, asset?: string): number {
  const decimals = getDecimals(asset);
  const raw = baseUnits.replace(/^0+/, '') || '0';

  if (raw === '0') return 0;

  // Pad with leading zeros if shorter than decimals
  const padded = raw.padStart(decimals + 1, '0');
  const wholeEnd = padded.length - decimals;
  const whole = padded.slice(0, wholeEnd);
  const frac = padded.slice(wholeEnd);

  return parseFloat(`${whole}.${frac}`);
}

/**
 * Get decimal places for a token asset address.
 */
function getDecimals(asset?: string): number {
  if (!asset) return DEFAULT_DECIMALS;
  return TOKEN_DECIMALS[asset.toLowerCase()] ?? DEFAULT_DECIMALS;
}

/**
 * Check whether a currency string is a hex token address (e.g., "0x20c0...").
 *
 * Real mppx servers use the token contract address as the currency field.
 * Hand-crafted or demo challenges use fiat strings like "USD" or "EUR".
 * This distinction determines whether the amount is in base units or human-readable.
 */
export function isTokenAddress(currency: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(currency);
}

/**
 * Convert an MPP amount to USD.
 *
 * When the currency is a hex token address (e.g., PathUSD "0x20c0..."), the
 * amount is in base units and must be converted using token decimals.
 * When the currency is a fiat string (e.g., "USD"), the amount is already
 * human-readable and is parsed directly.
 *
 * This handles the critical mismatch between real mppx servers (base units)
 * and hand-crafted demo challenges (human-readable amounts).
 */
export function mppAmountToUsd(amount: string, currency: string): number | undefined {
  const parsed = parseFloat(amount);
  if (!Number.isFinite(parsed)) return undefined;

  if (isTokenAddress(currency)) {
    // Currency is a token address — amount is in base units.
    // Convert using token decimals (defaults to 6 for unknown tokens).
    return fromBaseUnits(amount, currency);
  }

  // Currency is a fiat string (e.g., "USD", "EUR") — amount is human-readable.
  return parsed;
}

/**
 * Safety check: verify that a USD amount matches expected base units.
 * Returns true if the conversion is consistent.
 *
 * This is a logic check that prevents the unit mismatch bug:
 * - Server sends base units (e.g., "10000")
 * - Client converts to USD (e.g., 0.01)
 * - This function verifies 0.01 * 10^6 = 10000 ✓
 */
export function verifyAmountConsistency(
  baseUnits: string,
  usdAmount: number,
  asset?: string
): boolean {
  const decimals = getDecimals(asset);
  const reconverted = Math.round(usdAmount * Math.pow(10, decimals));
  const original = parseInt(baseUnits, 10);
  // Allow 1 unit tolerance for floating-point rounding
  return Math.abs(reconverted - original) <= 1;
}

/**
 * Get a human-readable token name for a currency string.
 *
 * If the currency is a known token address, returns the token name
 * (e.g., "PathUSD", "USDC (Base Sepolia)"). If the currency is a
 * fiat string like "USD", returns it as-is. For unknown token addresses,
 * returns the hex address unchanged.
 */
export function getTokenName(currency: string): string {
  if (!isTokenAddress(currency)) return currency;
  return TOKEN_NAMES[currency.toLowerCase()] ?? currency;
}

/**
 * Decode a base64url-encoded string to UTF-8 text.
 *
 * base64url uses `-` instead of `+` and `_` instead of `/`, with no padding.
 * This converts to standard base64 before decoding via atob().
 */
export function base64urlDecode(input: string): string {
  // Replace base64url characters with standard base64 equivalents
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if necessary
  const pad = base64.length % 4;
  if (pad === 2) base64 += '==';
  else if (pad === 3) base64 += '=';
  return atob(base64);
}
