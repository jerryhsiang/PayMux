import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayMux } from '../client/paymux.js';
import { SpendingLimitError } from '../client/spending.js';

describe('PayMux client', () => {
  describe('PayMux.create()', () => {
    it('creates a client with wallet config', () => {
      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      });
      expect(typeof agent.fetch).toBe('function');
      expect(typeof agent.spending).toBe('object');
    });

    it('creates a client without wallet (no payment capability)', () => {
      const agent = PayMux.create({});
      expect(typeof agent.fetch).toBe('function');
    });

    it('warns when privy wallet is configured (unsupported)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      PayMux.create({ wallet: { privy: { walletId: 'test' } } });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('privy'));
      warnSpy.mockRestore();
    });

    it('initializes spending stats at zero', () => {
      const agent = PayMux.create({ limits: { perRequest: 1, perDay: 50 } });
      const stats = agent.spending;
      expect(stats.dailySpend).toBe(0);
      expect(stats.pendingSpend).toBe(0);
      expect(stats.totalSpent).toBe(0);
      expect(stats.dailyLimit).toBe(50);
      expect(stats.dailyRemaining).toBe(50);
      expect(stats.history).toEqual([]);
    });
  });

  describe('fetch() — non-402 responses', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns non-402 responses without payment', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: 'free' }), { status: 200 })
      );

      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      });

      const response = await agent.fetch('https://example.com/api');
      expect(response.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('passes through 500 errors without payment attempt', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Internal Server Error', { status: 500 })
      );

      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      });

      const response = await agent.fetch('https://example.com/api');
      expect(response.status).toBe(500);
    });

    it('skipPayment bypasses all payment logic', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('', { status: 402 })
      );

      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      });

      const response = await agent.fetch('https://example.com/api', { skipPayment: true });
      expect(response.status).toBe(402); // Returned as-is, no payment attempt
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('strips PayMux options from native fetch call', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

      const agent = PayMux.create({});
      await agent.fetch('https://example.com/api', {
        maxAmount: 5,
        protocol: 'x402',
        skipPayment: true,
        headers: { 'X-Custom': 'value' },
      });

      const [, init] = (globalThis.fetch as any).mock.calls[0];
      // PayMux options should NOT be in the fetch init
      expect(init.maxAmount).toBeUndefined();
      expect(init.protocol).toBeUndefined();
      expect(init.skipPayment).toBeUndefined();
      // Regular fetch options should be preserved
      expect(init.headers['X-Custom']).toBe('value');
    });
  });

  describe('fetch() — 402 without wallet', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('throws helpful error when 402 received but no wallet', async () => {
      const x402Requirements = btoa(JSON.stringify({
        x402Version: 2,
        accepts: [{
          scheme: 'exact', network: 'eip155:8453',
          maxAmountRequired: '10000', payTo: '0x1', asset: '0x2',
        }],
      }));

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('', {
          status: 402,
          headers: { 'payment-required': x402Requirements },
        })
      );

      const agent = PayMux.create({}); // No wallet
      await expect(agent.fetch('https://example.com/paid')).rejects.toThrow('no wallet');
    });
  });

  describe('fetch() — spending limits enforcement', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('rejects when amount exceeds maxAmount', async () => {
      const x402Requirements = btoa(JSON.stringify({
        x402Version: 2,
        accepts: [{
          scheme: 'exact', network: 'eip155:8453',
          maxAmountRequired: '100000', // 0.10 USD
          payTo: '0x1', asset: '0x2',
        }],
      }));

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('', {
          status: 402,
          headers: { 'payment-required': x402Requirements },
        })
      );

      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      });

      await expect(
        agent.fetch('https://example.com/paid', { maxAmount: 0.05 })
      ).rejects.toThrow('exceeds maxAmount');
    });

    it('rejects when amount exceeds per-request limit', async () => {
      const x402Requirements = btoa(JSON.stringify({
        x402Version: 2,
        accepts: [{
          scheme: 'exact', network: 'eip155:8453',
          maxAmountRequired: '500000', // $0.50
          payTo: '0x1', asset: '0x2',
        }],
      }));

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('', {
          status: 402,
          headers: { 'payment-required': x402Requirements },
        })
      );

      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        limits: { perRequest: 0.10 },
      });

      await expect(
        agent.fetch('https://example.com/paid')
      ).rejects.toThrow(SpendingLimitError);
    });

    it('rejects when daily limit exhausted', async () => {
      const x402Requirements = btoa(JSON.stringify({
        x402Version: 2,
        accepts: [{
          scheme: 'exact', network: 'eip155:8453',
          maxAmountRequired: '10000', payTo: '0x1', asset: '0x2',
        }],
      }));

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('', {
          status: 402,
          headers: { 'payment-required': x402Requirements },
        })
      );

      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        limits: { perDay: 0.001 }, // Very low limit
      });

      // First, exhaust the limit via spending enforcer
      // The 402 will trigger check() with amount 10000 (base units parsed as string "10000")
      // which as a float is 10000 > 0.001, so per-day check should reject
      await expect(
        agent.fetch('https://example.com/paid')
      ).rejects.toThrow(SpendingLimitError);
    });
  });

  describe('fetch() — MPP fast path spending limits (cached URL)', () => {
    let originalFetch: typeof globalThis.fetch;

    /**
     * Helper to base64url-encode a JSON object (mimics real MPP request param).
     */
    function toBase64url(obj: unknown): string {
      const json = JSON.stringify(obj);
      return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    /**
     * Build a mock 402 response with an MPP WWW-Authenticate: Payment header.
     * The `request` param is base64url-encoded JSON with amount/currency.
     */
    function mockMpp402(amount: string, currency = 'USD'): Response {
      const requestPayload = { amount, currency, recipient: '0xABC' };
      return new Response(
        JSON.stringify({ error: 'Payment Required', protocols: ['mpp'] }),
        {
          status: 402,
          headers: {
            'www-authenticate': `Payment id="test123", realm="api", method="tempo", intent="charge", request="${toBase64url(requestPayload)}"`,
          },
        }
      );
    }

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('enforces per-request spending limit on MPP fast path BEFORE payment', async () => {
      // Mock fetch: always returns 402 with MPP challenge for $0.50
      globalThis.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(mockMpp402('0.50'))
      );

      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        limits: { perRequest: 0.10 }, // $0.10 limit, server charges $0.50
      });

      // First call: normal path detects MPP, caches the protocol,
      // then spending check rejects ($0.50 > $0.10 perRequest limit).
      // The protocol IS cached because caching happens before spending check.
      await expect(
        agent.fetch('https://example.com/mpp-api')
      ).rejects.toThrow(SpendingLimitError);

      // Clear the fetch mock call count so we can track the second call
      (globalThis.fetch as any).mockClear();

      // Second call: hits the MPP fast path (protocol cache hit).
      // CRITICAL: The fast path must enforce spending limits BEFORE payment.
      // If the fast path skipped limits, this would fail with an mppx error
      // (because mppx is not available in tests), not SpendingLimitError.
      await expect(
        agent.fetch('https://example.com/mpp-api')
      ).rejects.toThrow(SpendingLimitError);

      // Verify no payment was attempted — spending should be zero
      expect(agent.spending.totalSpent).toBe(0);
      expect(agent.spending.pendingSpend).toBe(0);
    });

    it('enforces per-day spending limit on MPP fast path BEFORE payment', async () => {
      globalThis.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(mockMpp402('0.05'))
      );

      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        limits: { perDay: 0.08 }, // $0.08 daily limit
      });

      // First call: normal path, detects MPP, caches, spending check passes
      // ($0.05 < $0.08), then fails at mppClient.pay() (no mppx in tests).
      // The pending amount is released on failure.
      try { await agent.fetch('https://example.com/mpp-daily'); } catch {}

      // Manually simulate a successful payment to use up most of the daily budget.
      // We need to push the daily spend close to the limit so the next call exceeds it.
      // Use setLimits to update, then make spending enforcer think we spent $0.05.
      // Instead, let's just set a very low daily limit and make two calls.
      agent.setLimits({ perDay: 0.04 }); // Tighten limit to $0.04

      (globalThis.fetch as any).mockClear();

      // Second call: fast path (cache hit). $0.05 > $0.04 daily limit.
      // Must throw SpendingLimitError BEFORE any payment attempt.
      await expect(
        agent.fetch('https://example.com/mpp-daily')
      ).rejects.toThrow(SpendingLimitError);

      expect(agent.spending.totalSpent).toBe(0);
    });

    it('enforces maxAmount on MPP fast path BEFORE payment', async () => {
      globalThis.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(mockMpp402('5.00'))
      );

      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        limits: { perRequest: 100 }, // High per-request limit
      });

      // First call: normal path, caches MPP protocol.
      // Amount $5.00 < perRequest $100, passes spending check.
      // Fails at mppClient.pay() (no mppx in tests).
      try { await agent.fetch('https://example.com/mpp-max'); } catch {}

      (globalThis.fetch as any).mockClear();

      // Second call: fast path with maxAmount override.
      // $5.00 > maxAmount $1.00 — must throw BEFORE payment.
      await expect(
        agent.fetch('https://example.com/mpp-max', { maxAmount: 1.00 })
      ).rejects.toThrow('exceeds maxAmount');

      expect(agent.spending.totalSpent).toBe(0);
    });

    it('fast path handles endpoint that stops requiring payment', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        // First two calls return 402 (initial detection + mppx attempt)
        // Third call (fast path probe) returns 200 (no longer requires payment)
        // Fourth call (re-fetch for response) returns 200
        if (callCount <= 2) {
          return Promise.resolve(mockMpp402('0.05'));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: 'free now' }), { status: 200 })
        );
      });

      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        limits: { perRequest: 1.00 },
      });

      // First call: detects MPP, caches, fails at mppClient.pay()
      try { await agent.fetch('https://example.com/mpp-free'); } catch {}

      // Second call: fast path probe gets 200 (no payment needed)
      const response = await agent.fetch('https://example.com/mpp-free');
      expect(response.status).toBe(200);
      expect(agent.spending.totalSpent).toBe(0);
    });
  });

  describe('debug logging', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('logs when debug: true', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

      const agent = PayMux.create({ debug: true });
      await agent.fetch('https://example.com/api');

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[paymux]'));
      logSpy.mockRestore();
    });

    it('does not log when debug: false', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

      const agent = PayMux.create({ debug: false });
      await agent.fetch('https://example.com/api');

      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });
});
