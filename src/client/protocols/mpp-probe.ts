import { mppAmountToUsd, base64urlDecode } from '../utils.js';

/**
 * MPP probe -- fetch the 402 challenge to extract payment amount WITHOUT paying.
 *
 * This is used by the MPP fast path to enforce spending limits BEFORE payment.
 * It performs a plain HTTP fetch (no payment headers) to get the 402 response,
 * then parses the WWW-Authenticate: Payment header to extract the amount.
 *
 * The amount is returned in USD. When the currency is a token address (real mppx
 * servers), base units are converted via token decimals. When the currency is a
 * fiat string like "USD" (demo/hand-crafted challenges), the amount is parsed directly.
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
 * @param timeoutMs - Timeout in milliseconds for the probe fetch (default: 10000ms / 10s).
 *                    Prevents the agent from blocking indefinitely if the server hangs.
 * @returns MppProbeResult if a valid MPP challenge is found, null otherwise.
 *          Returns null for non-402 responses (endpoint no longer requires payment).
 */
export async function probeMppAmount(
  url: string,
  init?: RequestInit,
  timeoutMs: number = 10_000
): Promise<MppProbeResult | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Merge the timeout signal with the caller's signal (if any).
  // AbortSignal.any() is not available in Node 18, so we wire them manually.
  const callerSignal = init?.signal as AbortSignal | undefined;
  let callerAbortHandler: (() => void) | undefined;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerAbortHandler = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener('abort', callerAbortHandler, { once: true });
    }
  }

  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(
        `PayMux: MPP probe timed out after ${timeoutMs}ms. The server may be unreachable. URL: ${url}`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    // M3 fix: Remove the abort listener to prevent accumulation
    if (callerSignal && callerAbortHandler) {
      callerSignal.removeEventListener('abort', callerAbortHandler);
    }
  }

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

  // Convert amount to USD using the same token-address-aware logic as detector.ts.
  // Real mppx servers send token addresses as currency and base units as amount.
  // Hand-crafted challenges send fiat strings like "USD" with human-readable amounts.
  const amountUsd = mppAmountToUsd(amountRaw, currency);

  if (amountUsd === undefined) {
    return null;
  }

  return {
    amountUsd,
    amountRaw,
    currency,
    status: response.status,
  };
}

