import { describe, it, expect } from 'vitest';
import { detectProtocol, selectBestRequirement } from '../client/protocols/detector.js';

/**
 * Helper to create a mock 402 Response with headers
 */
function mock402(headers: Record<string, string>, body?: unknown): Response {
  const h = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    h.set(key, value);
  }
  return new Response(body ? JSON.stringify(body) : null, {
    status: 402,
    headers: h,
  });
}

describe('detectProtocol', () => {
  describe('x402 detection', () => {
    it('detects x402 v2 from PAYMENT-REQUIRED header', async () => {
      const requirements = {
        x402Version: 2,
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          maxAmountRequired: '10000',
          payTo: '0xRecipient',
          asset: '0xUSDC',
        }],
      };
      const encoded = btoa(JSON.stringify(requirements));
      const response = mock402({ 'payment-required': encoded });

      const result = await detectProtocol(response);
      expect(result).toHaveLength(1);
      expect(result[0].protocol).toBe('x402');
      expect(result[0].amount).toBe('10000');
      expect(result[0].chain).toBe('base');
      expect(result[0].payTo).toBe('0xRecipient');
    });

    it('detects x402 v1 from PAYMENT-REQUIRED header', async () => {
      const requirements = {
        payTo: '0xRecipient',
        network: 'eip155:84532',
        maxAmountRequired: '5000',
        asset: '0xUSDC',
        scheme: 'exact',
      };
      const encoded = btoa(JSON.stringify(requirements));
      const response = mock402({ 'payment-required': encoded });

      const result = await detectProtocol(response);
      expect(result).toHaveLength(1);
      expect(result[0].protocol).toBe('x402');
      expect(result[0].amount).toBe('5000');
      expect(result[0].chain).toBe('base-sepolia');
    });

    it('maps CAIP-2 networks to chain names', async () => {
      const testCases: [string, string][] = [
        ['eip155:8453', 'base'],
        ['eip155:84532', 'base-sepolia'],
        ['eip155:137', 'polygon'],
        ['eip155:1', 'ethereum'],
        ['eip155:99999', 'eip155:99999'], // Unknown chain passes through
      ];

      for (const [network, expectedChain] of testCases) {
        const encoded = btoa(JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: 'exact', network, maxAmountRequired: '100', payTo: '0x1', asset: '0x2' }],
        }));
        const response = mock402({ 'payment-required': encoded });
        const result = await detectProtocol(response);
        expect(result[0].chain).toBe(expectedChain);
      }
    });

    it('handles malformed base64 gracefully', async () => {
      const response = mock402({ 'payment-required': 'not-valid-base64!!!' });
      const result = await detectProtocol(response);
      expect(result).toHaveLength(0);
    });

    it('handles malformed JSON gracefully', async () => {
      const response = mock402({ 'payment-required': btoa('not json') });
      const result = await detectProtocol(response);
      expect(result).toHaveLength(0);
    });
  });

  describe('MPP detection', () => {
    it('detects MPP from WWW-Authenticate: Payment header', async () => {
      const response = mock402({
        'www-authenticate': 'Payment id="abc123", realm="my-api", method="tempo", intent="charge", request="eyJ0ZXN0IjoxfQ"',
      });

      const result = await detectProtocol(response);
      expect(result).toHaveLength(1);
      expect(result[0].protocol).toBe('mpp');
      expect(result[0].challengeId).toBe('abc123');
    });

    it('extracts amount from MPP challenge params', async () => {
      const response = mock402({
        'www-authenticate': 'Payment amount="0.05", currency="USD"',
      });

      const result = await detectProtocol(response);
      expect(result).toHaveLength(1);
      expect(result[0].protocol).toBe('mpp');
      expect(result[0].amount).toBe('0.05');
      expect(result[0].currency).toBe('USD');
    });

    it('defaults MPP amount to 0 and currency to USD', async () => {
      const response = mock402({
        'www-authenticate': 'Payment realm="test"',
      });

      const result = await detectProtocol(response);
      expect(result[0].amount).toBe('0');
      expect(result[0].currency).toBe('USD');
    });
  });

  describe('dual protocol detection', () => {
    it('detects both x402 and MPP when both headers present', async () => {
      const x402 = btoa(JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '10000', payTo: '0x1', asset: '0x2' }],
      }));

      const response = mock402({
        'payment-required': x402,
        'www-authenticate': 'Payment amount="0.01", currency="USD"',
      });

      const result = await detectProtocol(response);
      expect(result).toHaveLength(2);
      expect(result.map(r => r.protocol)).toContain('x402');
      expect(result.map(r => r.protocol)).toContain('mpp');
    });
  });

  describe('body fallback', () => {
    it('detects x402 from response body when no headers', async () => {
      const body = {
        x402Version: 2,
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          maxAmountRequired: '10000',
          payTo: '0xRecipient',
          asset: '0xUSDC',
        }],
      };
      const response = mock402({}, body);

      const result = await detectProtocol(response);
      expect(result).toHaveLength(1);
      expect(result[0].protocol).toBe('x402');
    });

    it('returns empty for non-402 response', async () => {
      const response = new Response('OK', { status: 200 });
      const result = await detectProtocol(response);
      expect(result).toHaveLength(0);
    });
  });
});

describe('selectBestRequirement', () => {
  it('returns null for empty array', () => {
    expect(selectBestRequirement([])).toBeNull();
  });

  it('returns the only item for single-element array', () => {
    const req = { protocol: 'x402' as const, amount: '100', currency: 'USDC' };
    expect(selectBestRequirement([req])).toBe(req);
  });

  it('prefers MPP over x402 by default', () => {
    const x402 = { protocol: 'x402' as const, amount: '100', currency: 'USDC' };
    const mpp = { protocol: 'mpp' as const, amount: '100', currency: 'USD' };
    expect(selectBestRequirement([x402, mpp])?.protocol).toBe('mpp');
  });

  it('respects preferredProtocol override', () => {
    const x402 = { protocol: 'x402' as const, amount: '100', currency: 'USDC' };
    const mpp = { protocol: 'mpp' as const, amount: '100', currency: 'USD' };
    expect(selectBestRequirement([x402, mpp], ['x402'])?.protocol).toBe('x402');
  });

  it('falls back to default priority when preferred is not available', () => {
    const x402 = { protocol: 'x402' as const, amount: '100', currency: 'USDC' };
    expect(selectBestRequirement([x402], ['mpp'])?.protocol).toBe('x402');
  });
});
