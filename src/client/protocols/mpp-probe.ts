/**
 * MPP probe — fetch the 402 challenge to extract payment amount WITHOUT paying.
 *
 * This is used by the MPP fast path to enforce spending limits BEFORE payment.
 * It performs a plain HTTP fetch (no payment headers) to get the 402 response,
 * then parses the WWW-Authenticate: Payment header to extract the amount.
 *
 * The amount is returned in USD (MPP amounts are human-readable, e.g. "0.05").
 * Returns null if the endpoint does not return a 402 or does not have an MPP challenge.
 */

/**
 * Result of an MPP probe — the amount extracted from the 402 challenge.
 */
export interface MppProbeResult {
  /** Amount in USD (parsed from the MPP challenge) */
  amountUsd: number;
  /** Raw amount string from the challenge */
  amountRaw: string;
  /** Currency from the challenge (usually "USD") */
  currency: string;
  /** The HTTP status code of the probe response */
  status: number;
}

/**
 * Probe an MPP endpoint to extract the payment amount without paying.
 *
 * Sends a plain fetch (no payment credentials) to trigger a 402 response,
 * then parses the WWW-Authenticate: Payment header to extract the amount.
 *
 * @returns MppProbeResult if a valid MPP challenge is found, null otherwise.
 *          Returns null for non-402 responses (endpoint no longer requires payment).
 */
export async function probeMppAmount(
  url: string,
  init?: RequestInit
): Promise<MppProbeResult | null> {
  const response = await globalThis.fetch(url, init);

  // If not 402, the endpoint no longer requires payment
  if (response.status !== 402) {
    return null;
  }

  // Look for MPP's WWW-Authenticate: Payment header
  const authHeader = response.headers.get('www-authenticate');
  if (!authHeader || !authHeader.toLowerCase().startsWith('payment')) {
    return null;
  }

  // Parse the challenge to extract amount
  // MPP challenge format:
  //   Payment id="abc", realm="api", method="tempo", intent="charge",
  //     request="eyJhbW91bnQiOiIwLjA1IiwiY3VycmVuY3kiOiJVU0QiLC4uLn0"
  const params: Record<string, string> = {};
  const paramRegex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = paramRegex.exec(authHeader)) !== null) {
    params[match[1]] = match[2];
  }

  // Decode the `request` param (base64url-encoded JSON with amount/currency)
  let requestData: Record<string, unknown> | undefined;
  if (params.request) {
    try {
      requestData = JSON.parse(base64urlDecode(params.request));
    } catch {
      // Malformed request param — fall through to top-level params
    }
  }

  const amountRaw = String(requestData?.amount ?? params.amount ?? '0');
  const currency = String(requestData?.currency ?? params.currency ?? 'USD');
  const parsed = parseFloat(amountRaw);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return {
    amountUsd: parsed,
    amountRaw,
    currency,
    status: response.status,
  };
}

/**
 * Decode a base64url-encoded string to UTF-8 text.
 */
function base64urlDecode(input: string): string {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad === 2) base64 += '==';
  else if (pad === 3) base64 += '=';
  return atob(base64);
}
