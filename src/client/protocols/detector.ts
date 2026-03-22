import type { PaymentRequirement, Protocol } from '../../shared/types.js';
import { fromBaseUnits, mppAmountToUsd } from '../utils.js';

/**
 * Header names used by payment protocols
 */
const PAYMENT_REQUIRED_HEADER = 'payment-required';
const WWW_AUTHENTICATE_HEADER = 'www-authenticate';
const X402_VERSION_HEADER = 'x402-version';

/**
 * Detect payment protocol from an HTTP 402 response.
 *
 * x402: Returns base64-encoded JSON in PAYMENT-REQUIRED header
 * MPP:  Returns WWW-Authenticate: Payment challenge (week 2)
 */
export async function detectProtocol(
  response: Response
): Promise<PaymentRequirement[]> {
  if (response.status !== 402) {
    return [];
  }

  const requirements: PaymentRequirement[] = [];

  // Check for x402 protocol (PAYMENT-REQUIRED header)
  const x402Header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (x402Header) {
    const x402Version = response.headers.get(X402_VERSION_HEADER);
    const x402Req = parseX402Header(x402Header, x402Version);
    if (x402Req) {
      requirements.push(...x402Req);
    }
  }

  // Check for MPP protocol (WWW-Authenticate: Payment) — week 2
  const authHeader = response.headers.get(WWW_AUTHENTICATE_HEADER);
  if (authHeader && authHeader.toLowerCase().startsWith('payment')) {
    const mppReq = parseMppChallenge(authHeader);
    if (mppReq) {
      requirements.push(mppReq);
    }
  }

  // If we couldn't detect from headers, try parsing the response body
  if (requirements.length === 0) {
    try {
      const body = (await response.clone().json()) as Record<string, unknown>;
      const bodyReq = parsePaymentBody(body);
      if (bodyReq) {
        requirements.push(...bodyReq);
      }
    } catch {
      // Body is not JSON or not parseable — protocol unknown
    }
  }

  return requirements;
}

/**
 * Parse x402 PAYMENT-REQUIRED header (base64-encoded JSON)
 *
 * When x402Version is provided via the x402-version header, it is used to
 * determine whether to apply v1 (flat object) or v2 (accepts array) parsing.
 * When absent, the parser falls back to structural detection.
 */
function parseX402Header(
  headerValue: string,
  x402Version: string | null
): PaymentRequirement[] | null {
  try {
    // Note: atob is globally available in all supported runtimes (Node >= 18,
    // Cloudflare Workers, Deno, and browsers). No polyfill is needed.
    const decoded = atob(headerValue);
    const parsed = JSON.parse(decoded);

    // If the server explicitly declares x402 version 2, use v2 parsing
    if (x402Version === '2' || x402Version === 'v2') {
      return parseX402V2(parsed);
    }

    // If the server explicitly declares x402 version 1, use v1 parsing
    if (x402Version === '1' || x402Version === 'v1') {
      return parseX402V1(parsed);
    }

    // No explicit version header — fall back to structural detection
    // x402 v2 format: { version, accepts: [...], resource }
    if (parsed.accepts && Array.isArray(parsed.accepts)) {
      return parseX402V2(parsed);
    }

    // x402 v1 format: direct payment requirement object
    if (parsed.payTo || parsed.network) {
      return parseX402V1(parsed);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse x402 v2 format: { version, accepts: [...], resource }
 */
function parseX402V2(
  parsed: Record<string, unknown>
): PaymentRequirement[] | null {
  const accepts = parsed.accepts;
  if (!accepts || !Array.isArray(accepts)) {
    return null;
  }

  return accepts.map(
    (accept: Record<string, unknown>): PaymentRequirement => {
      const baseAmount = String(accept.maxAmountRequired ?? accept.price ?? '0');
      const asset = String(accept.asset ?? '');
      return {
        protocol: 'x402' as Protocol,
        amount: baseAmount,
        currency: asset || 'USDC',
        // CRITICAL: Convert base units to USD for spending limit comparison.
        // x402 sends amounts in token base units (e.g., "10000" = $0.01 for 6-decimal USDC).
        // SpendingEnforcer limits are in USD. Without this conversion, a $0.01 payment
        // would be compared as 10000 > 1.00 (perRequest), incorrectly blocking it.
        amountUsd: fromBaseUnits(baseAmount, asset || undefined),
        recipient: String(accept.payTo ?? ''),
        chain: networkToChain(String(accept.network ?? '')),
        network: String(accept.network ?? ''),
        payTo: String(accept.payTo ?? ''),
        scheme: String(accept.scheme ?? 'exact'),
        maxAmountRequired: baseAmount,
        asset,
        resource: String(parsed.resource ?? ''),
        raw: accept,
      };
    }
  );
}

/**
 * Parse x402 v1 format: flat payment requirement object
 */
function parseX402V1(
  parsed: Record<string, unknown>
): PaymentRequirement[] | null {
  if (!parsed.payTo && !parsed.network) {
    return null;
  }

  const baseAmount = String(parsed.maxAmountRequired ?? parsed.price ?? parsed.amount ?? '0');
  const asset = String(parsed.asset ?? '');
  return [
    {
      protocol: 'x402',
      amount: baseAmount,
      currency: asset || 'USDC',
      amountUsd: fromBaseUnits(baseAmount, asset || undefined),
      recipient: String(parsed.payTo ?? ''),
      chain: networkToChain(String(parsed.network ?? '')),
      network: String(parsed.network ?? ''),
      payTo: String(parsed.payTo ?? ''),
      scheme: String(parsed.scheme ?? 'exact'),
      raw: parsed,
    },
  ];
}

/**
 * Parse MPP WWW-Authenticate: Payment challenge.
 *
 * MPP uses the HTTP Payment Authentication Scheme (RFC draft).
 * The 402 response contains a WWW-Authenticate header with challenge params.
 * mppx handles the full challenge/response flow internally, so we just need
 * to detect that this IS an MPP challenge and extract basic info.
 *
 * Real MPP challenge format:
 *   Payment id="abc", realm="api", method="tempo", intent="charge",
 *     request="eyJhbW91bnQiOiIwLjA1IiwiY3VycmVuY3kiOiJVU0QiLC4uLn0"
 *
 * The `request` field is base64url-encoded JSON containing the actual
 * payment details: { amount, currency, recipient, ... }.
 * The amount is NOT a top-level param in the challenge header.
 */
function parseMppChallenge(
  headerValue: string
): PaymentRequirement | null {
  // MPP challenge starts with "Payment" scheme
  if (!headerValue.toLowerCase().startsWith('payment')) {
    return null;
  }

  // Extract params from the challenge string
  // Top-level params: id, realm, method, intent, request (base64url-encoded JSON)
  const params: Record<string, string> = {};
  const paramRegex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = paramRegex.exec(headerValue)) !== null) {
    params[match[1]] = match[2];
  }

  // Decode the `request` param to extract the actual amount and currency.
  // The request field is base64url-encoded JSON: { amount, currency, recipient, ... }
  let requestData: Record<string, unknown> | undefined;
  if (params.request) {
    try {
      requestData = JSON.parse(base64urlDecode(params.request));
    } catch {
      // Malformed request param — fall through to top-level params
    }
  }

  // Amount priority: decoded request data > top-level params > '0'
  const amount = String(requestData?.amount ?? params.amount ?? '0');
  const currency = String(requestData?.currency ?? params.currency ?? 'USD');

  // MPP amount interpretation depends on the currency field:
  // - Token address (e.g., "0x20c0..."): amount is in base units, convert via token decimals.
  //   Real mppx servers send the token contract address as currency and base units as amount.
  //   Example: amount="10000", currency="0x20c0..." -> 10000 / 10^6 = $0.01
  // - Fiat string (e.g., "USD"): amount is human-readable, parse directly.
  //   Hand-crafted or demo challenges use this format for backward compatibility.
  //   Example: amount="0.05", currency="USD" -> $0.05
  const amountUsd = mppAmountToUsd(amount, currency);

  return {
    protocol: 'mpp',
    amount,
    currency,
    amountUsd,
    challengeId: params.challenge ?? params.id ?? undefined,
    paymentMethods: params.methods?.split(',') ?? undefined,
    raw: { header: headerValue, params, requestData },
  };
}

/**
 * Decode a base64url-encoded string to UTF-8 text.
 *
 * base64url uses `-` instead of `+` and `_` instead of `/`, with no padding.
 * This converts to standard base64 before decoding via atob().
 */
function base64urlDecode(input: string): string {
  // Replace base64url characters with standard base64 equivalents
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if necessary
  const pad = base64.length % 4;
  if (pad === 2) base64 += '==';
  else if (pad === 3) base64 += '=';
  return atob(base64);
}

/**
 * Try to parse payment requirements from response body.
 *
 * Checks for an x402Version field in the body to determine v1 vs v2 parsing.
 * Falls back to structural detection if no version is present.
 */
function parsePaymentBody(
  body: Record<string, unknown>
): PaymentRequirement[] | null {
  const bodyVersion = body.x402Version ?? body.version;

  // If body explicitly declares v2, use v2 parsing
  if (bodyVersion === 2 || bodyVersion === '2' || bodyVersion === 'v2') {
    return parseX402V2(body);
  }

  // If body explicitly declares v1, use v1 parsing
  if (bodyVersion === 1 || bodyVersion === '1' || bodyVersion === 'v1') {
    return parseX402V1(body);
  }

  // No explicit version — fall back to structural detection
  // x402 v2 format in body
  if (body.accepts && Array.isArray(body.accepts)) {
    return parseX402V2(body);
  }

  // x402 v1 format in body
  if (body.payTo || body.network) {
    return parseX402V1(body);
  }

  return null;
}

/**
 * Convert CAIP-2 network identifier to chain shortname.
 *
 * Covers EVM chains (eip155:*) as well as Solana and Avalanche.
 */
function networkToChain(network: string): string {
  const chainMap: Record<string, string> = {
    'eip155:8453': 'base',
    'eip155:84532': 'base-sepolia',
    'eip155:137': 'polygon',
    'eip155:80002': 'polygon-amoy',
    'eip155:1': 'ethereum',
    'eip155:11155111': 'ethereum-sepolia',
    'eip155:43114': 'avalanche',
    'eip155:43113': 'avalanche-fuji',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana-devnet',
  };
  return chainMap[network] ?? network;
}

/**
 * Select the best payment requirement from available options.
 *
 * If the caller specifies a preferred protocol list, those are tried first
 * in order. Otherwise, the default priority is:
 *
 *   1. **MPP** -- preferred because it supports streaming/session-based payments
 *      with lower per-request overhead and built-in session management.
 *   2. **x402** -- per-request micropayments; simple but higher overhead per call.
 *   3. **card** -- traditional card rails; highest latency, used as fallback.
 *
 * Returns `null` if no requirements are provided.
 */
export function selectBestRequirement(
  requirements: PaymentRequirement[],
  preferredProtocol?: Protocol[]
): PaymentRequirement | null {
  if (requirements.length === 0) return null;
  if (requirements.length === 1) return requirements[0];

  // If user has protocol preference, try to match
  if (preferredProtocol) {
    for (const pref of preferredProtocol) {
      const match = requirements.find((r) => r.protocol === pref);
      if (match) return match;
    }
  }

  // Default preference: mpp > x402 > card
  const protocolPriority: Protocol[] = ['mpp', 'x402', 'card'];
  for (const proto of protocolPriority) {
    const match = requirements.find((r) => r.protocol === proto);
    if (match) return match;
  }

  return requirements[0];
}
