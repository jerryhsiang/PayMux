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
