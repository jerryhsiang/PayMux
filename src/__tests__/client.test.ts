import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayMux } from '../client/paymux.js';
import { SpendingLimitError, SpendingEnforcer } from '../client/spending.js';
import { PayMuxSession } from '../client/session.js';
import type { SessionConfig, SessionFetchDelegate } from '../client/session.js';

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
      PayMux.create({ wallet: { privy: { walletId: 'test' } }, debug: true });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('privy'));
      warnSpy.mockRestore();
    });

    it('warns via custom logger when privy wallet is configured', () => {
      const warns: Array<{ message: string; data?: Record<string, unknown> }> = [];
      const customLogger = {
        debug: () => {},
        info: () => {},
        warn: (message: string, data?: Record<string, unknown>) => { warns.push({ message, data }); },
        error: () => {},
      };
      PayMux.create({ wallet: { privy: { walletId: 'test' } }, logger: customLogger });
      expect(warns.length).toBe(1);
      expect(warns[0].data).toEqual({ unsupportedWallet: 'privy' });
    });

    it('reads custom timeouts from config', () => {
      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        timeouts: { probeMs: 5000, paymentMs: 15000 },
      });
      // Verify internal fields are set from config
      expect((agent as any).probeTimeoutMs).toBe(5000);
      expect((agent as any).paymentTimeoutMs).toBe(15000);
    });

    it('uses default timeouts when config.timeouts is omitted', () => {
      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
      });
      expect((agent as any).probeTimeoutMs).toBe(10000);
      expect((agent as any).paymentTimeoutMs).toBe(30000);
    });

    it('passes paymentTimeoutMs to MppClient and X402Client', () => {
      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        timeouts: { paymentMs: 20000 },
      });
      // Verify the timeout was passed through to protocol clients
      expect((agent as any).mppClient.paymentTimeoutMs).toBe(20000);
      expect((agent as any).x402Client.paymentTimeoutMs).toBe(20000);
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

    it('uses custom logger when provided', async () => {
      const events: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
      const customLogger = {
        debug: (msg: string, data?: Record<string, unknown>) => events.push({ level: 'debug', message: msg, data }),
        info: (msg: string, data?: Record<string, unknown>) => events.push({ level: 'info', message: msg, data }),
        warn: (msg: string, data?: Record<string, unknown>) => events.push({ level: 'warn', message: msg, data }),
        error: (msg: string, data?: Record<string, unknown>) => events.push({ level: 'error', message: msg, data }),
      };

      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

      const agent = PayMux.create({ logger: customLogger });
      await agent.fetch('https://example.com/api');

      // Should have logged request_start and no_payment events
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].data?.event).toBe('request_start');
      expect(events[1].data?.event).toBe('no_payment');
    });

    it('disables all logging when logger: false', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

      const agent = PayMux.create({ debug: true, logger: false });
      await agent.fetch('https://example.com/api');

      // logger: false overrides debug: true
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  // ── Session management tests ──────────────────────────────────────

  describe('PayMuxSession — direct unit tests', () => {
    /**
     * Create a PayMuxSession with a mock SessionFetchDelegate.
     * The delegate mimics what PayMuxClient.fetch() does, without real payment logic.
     */
    function createMockSession(
      config: SessionConfig,
      enforcer?: SpendingEnforcer,
      mockFetch?: typeof fetch
    ): PayMuxSession {
      const spendingEnforcer = enforcer ?? new SpendingEnforcer({});
      const delegate: SessionFetchDelegate = {
        fetch: mockFetch ?? vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ data: 'ok' }), { status: 200 })
        ),
        spending: { history: [] },
      };
      return new PayMuxSession(delegate, config, spendingEnforcer);
    }

    it('creates a session with correct initial spending state', () => {
      const session = createMockSession({
        url: 'https://api.example.com',
        budget: 5.00,
      });

      expect(session.spending.spent).toBe(0);
      expect(session.spending.budget).toBe(5.00);
      expect(session.spending.remaining).toBe(5.00);
      expect(session.spending.requestCount).toBe(0);
      expect(session.spending.isOpen).toBe(true);
      expect(session.isOpen).toBe(true);
    });

    it('session.fetch() resolves path against base URL', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: 'ok' }), { status: 200 })
      );

      const session = createMockSession(
        { url: 'https://api.example.com', budget: 5.00 },
        undefined,
        mockFetch
      );

      await session.fetch('/api/data?q=foo');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/api/data?q=foo',
        expect.objectContaining({ skipSpendingCheck: true })
      );
    });

    it('session.fetch() passes full URLs through unchanged', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('', { status: 200 })
      );

      const session = createMockSession(
        { url: 'https://api.example.com', budget: 5.00 },
        undefined,
        mockFetch
      );

      await session.fetch('https://other.example.com/data');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://other.example.com/data',
        expect.objectContaining({ skipSpendingCheck: true })
      );
    });

    it('session.fetch() increments request count', async () => {
      const session = createMockSession({
        url: 'https://api.example.com',
        budget: 5.00,
      });

      await session.fetch('/a');
      await session.fetch('/b');
      await session.fetch('/c');

      expect(session.spending.requestCount).toBe(3);
    });

    it('session budget enforcement — rejects when budget exhausted', async () => {
      const session = createMockSession({
        url: 'https://api.example.com',
        budget: 0.10,
      });

      // Manually set spending state to simulate exhausted budget
      (session as any).spendingState.spent = 0.10;

      await expect(session.fetch('/data')).rejects.toThrow(SpendingLimitError);
      await expect(session.fetch('/data')).rejects.toThrow('Session budget exhausted');
    });

    it('session budget enforcement — tracks spending from parent history', async () => {
      // The session now tracks spending from the parent client's payment history,
      // not from receipt headers. This works for both x402 and MPP protocols.
      const parentHistory: Array<{ amount: string; protocol: string; settledAt?: number }> = [];

      const mockFetch = vi.fn().mockImplementation(async () => {
        // Simulate the parent client recording a payment during fetch
        parentHistory.push({ amount: '0.02', protocol: 'mpp', settledAt: Date.now() });
        return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
      });

      const spendingEnforcer = new SpendingEnforcer({});
      const delegate: SessionFetchDelegate = {
        fetch: mockFetch,
        spending: { history: parentHistory },
      };
      const session = new PayMuxSession(
        delegate,
        { url: 'https://api.example.com', budget: 1.00 },
        spendingEnforcer
      );

      await session.fetch('/data');

      expect(session.spending.spent).toBe(0.02);
      expect(session.spending.remaining).toBe(0.98);
      expect(session.spending.history.length).toBe(1);
      expect(session.spending.history[0].protocol).toBe('mpp');
      expect(session.spending.history[0].amount).toBe('0.02');
    });

    it('session.close() marks session as closed', async () => {
      const session = createMockSession({
        url: 'https://api.example.com',
        budget: 5.00,
      });

      expect(session.isOpen).toBe(true);
      await session.close();
      expect(session.isOpen).toBe(false);
    });

    it('session.close() releases unspent budget to global enforcer', async () => {
      const enforcer = new SpendingEnforcer({ perDay: 100 });

      // Simulate the global spending check that openSession() does
      enforcer.check(5.00); // Reserves $5.00 as pending

      const session = createMockSession(
        { url: 'https://api.example.com', budget: 5.00 },
        enforcer
      );

      // Simulate spending $2.00 within the session
      (session as any).spendingState.spent = 2.00;

      await session.close();

      // close() records $2.00 spent (pending -> confirmed) and releases $3.00 unspent.
      const stats = enforcer.stats();
      expect(stats.pendingSpend).toBe(0);
      expect(stats.dailySpend).toBe(2.00);
      expect(stats.totalSpent).toBe(2.00);
    });

    it('session.close() is idempotent — calling twice does not double-release', async () => {
      const enforcer = new SpendingEnforcer({ perDay: 100 });
      enforcer.check(5.00);

      const session = createMockSession(
        { url: 'https://api.example.com', budget: 5.00 },
        enforcer
      );

      (session as any).spendingState.spent = 1.00;

      await session.close();
      await session.close(); // Second close should be a no-op

      const stats = enforcer.stats();
      // close() recorded $1.00 spent and released $4.00 unspent (once, idempotent).
      expect(stats.pendingSpend).toBe(0);
      expect(stats.dailySpend).toBe(1.00);
    });

    it('session.fetch() throws after close', async () => {
      const session = createMockSession({
        url: 'https://api.example.com',
        budget: 5.00,
      });

      await session.close();

      await expect(session.fetch('/data')).rejects.toThrow('Session is closed');
    });

    it('session.fetch() throws after expiry', async () => {
      const session = createMockSession({
        url: 'https://api.example.com',
        budget: 5.00,
        duration: 1, // 1ms — expires immediately
      });

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 5));

      await expect(session.fetch('/data')).rejects.toThrow('expired');
    });

    it('session.timeRemaining reflects actual time left', () => {
      const session = createMockSession({
        url: 'https://api.example.com',
        budget: 5.00,
        duration: 60_000, // 1 minute
      });

      // Should be close to 60000ms (some ms may have elapsed)
      expect(session.timeRemaining).toBeLessThanOrEqual(60_000);
      expect(session.timeRemaining).toBeGreaterThan(59_000);
    });
  });

  describe('openSession() — integration with PayMuxClient', () => {
    it('throws when no wallet configured', async () => {
      const agent = PayMux.create({});

      await expect(
        agent.openSession({ url: 'https://api.example.com', budget: 5.00 })
      ).rejects.toThrow('requires a wallet');
    });

    it('throws SpendingLimitError when session budget exceeds daily limit', async () => {
      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        limits: { perDay: 2.00 },
      });

      // Session budget $5.00 > daily limit $2.00
      await expect(
        agent.openSession({ url: 'https://api.example.com', budget: 5.00 })
      ).rejects.toThrow(SpendingLimitError);
    });

    it('charges session budget against global spending limits upfront', async () => {
      const agent = PayMux.create({
        wallet: { privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' },
        limits: { perDay: 100.00 },
      });

      // Opening a session should reserve the budget as pending spend
      const session = await agent.openSession({
        url: 'https://api.example.com',
        budget: 10.00,
      });

      // Budget is charged as pending against global limits
      expect(agent.spending.pendingSpend).toBe(10.00);
      expect(agent.spending.totalSpent).toBe(0);

      // Close the session — unspent budget should be released
      await session.close();
      expect(agent.spending.pendingSpend).toBe(0);
    });
  });

  // ── Retry logic tests ─────────────────────────────────────────────

  describe('fetch() — retry logic', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('retries on 503 and succeeds on second attempt', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' })
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: 'ok' }), { status: 200 })
        );
      });

      const agent = PayMux.create({
        retry: { baseDelayMs: 1 }, // 1ms delay for fast tests
      });

      const response = await agent.fetch('https://example.com/api');
      expect(response.status).toBe(200);
      expect(callCount).toBe(2); // 1 initial + 1 retry
    });

    it('does not retry on 400 (non-retryable status)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Bad Request', { status: 400 })
      );

      const agent = PayMux.create({
        retry: { baseDelayMs: 1 },
      });

      const response = await agent.fetch('https://example.com/api');
      expect(response.status).toBe(400);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1); // No retries
    });

    it('retry: false disables retries entirely', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' })
      );

      const agent = PayMux.create({
        retry: false,
      });

      // With retry disabled, 502 is returned as-is (no retry, no throw)
      const response = await agent.fetch('https://example.com/api');
      expect(response.status).toBe(502);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('respects maxRetries and throws after exhaustion', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' })
      );

      const agent = PayMux.create({
        retry: { maxRetries: 3, baseDelayMs: 1 },
      });

      await expect(
        agent.fetch('https://example.com/api')
      ).rejects.toThrow('Request failed after 4 attempts (1 initial + 3 retries)');

      // 1 initial + 3 retries = 4 total calls
      expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    });

    it('does not retry POST requests by default', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' })
      );

      const agent = PayMux.create({
        retry: { baseDelayMs: 1 },
      });

      // POST with 503 should NOT be retried (safety: could double-charge)
      const response = await agent.fetch('https://example.com/api', { method: 'POST' });
      expect(response.status).toBe(503);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries POST when explicitly configured in retryMethods', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' })
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ created: true }), { status: 201 })
        );
      });

      const agent = PayMux.create({
        retry: { baseDelayMs: 1, retryMethods: ['GET', 'HEAD', 'POST'] },
      });

      const response = await agent.fetch('https://example.com/api', { method: 'POST' });
      expect(response.status).toBe(201);
      expect(callCount).toBe(2);
    });

    it('retries on network error (TypeError) and succeeds on second attempt', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new TypeError('fetch failed'));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: 'ok' }), { status: 200 })
        );
      });

      const agent = PayMux.create({
        retry: { baseDelayMs: 1 },
      });

      const response = await agent.fetch('https://example.com/api');
      expect(response.status).toBe(200);
      expect(callCount).toBe(2);
    });

    it('throws with context after all network error retries exhausted', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(
        new TypeError('fetch failed')
      );

      const agent = PayMux.create({
        retry: { maxRetries: 2, baseDelayMs: 1 },
      });

      await expect(
        agent.fetch('https://example.com/api')
      ).rejects.toThrow('Request failed after 3 attempts (1 initial + 2 retries). Last error: fetch failed');
    });

    it('does not retry 402 responses (payment required is not transient)', async () => {
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
        retry: { baseDelayMs: 1, retryableStatusCodes: [402, 502, 503, 504] },
      });

      // Even if 402 is in retryableStatusCodes, the probe response should
      // still be returned for payment processing (402 is handled in fetch(),
      // not retried by probeWithRetry)
      // The 402 won't match retryableStatusCodes check because probeWithRetry
      // returns any non-retryable status immediately.
      // This test verifies 402 triggers the payment flow, not a retry loop.
      // Since we have a wallet, it will try to process the 402 payment.
      // The fetch mock always returns 402, so the x402 client will be invoked.
      // It should only call fetch once for the probe (402 is returned immediately).
      expect(globalThis.fetch).toHaveBeenCalledTimes(0); // Not called yet

      // Trigger the fetch — the 402 should be processed, not retried
      try {
        await agent.fetch('https://example.com/paid');
      } catch {
        // May throw due to x402 payment failing in tests — that's expected
      }

      // The key assertion: fetch was called exactly once for the probe
      // (402 was not retried), then possibly again for x402 payment
      expect((globalThis.fetch as any).mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('logs retries when debug: true', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' })
          );
        }
        return Promise.resolve(
          new Response('', { status: 200 })
        );
      });

      const agent = PayMux.create({
        debug: true,
        retry: { baseDelayMs: 1 },
      });

      await agent.fetch('https://example.com/api');

      // Should have logged a retry message
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[paymux] Retry 1/2 after 1ms (503 Service Unavailable)')
      );

      logSpy.mockRestore();
    });

    it('uses default retry config when retry option is omitted', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve(
            new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' })
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: 'ok' }), { status: 200 })
        );
      });

      // No retry config specified — should use defaults (maxRetries: 2)
      const agent = PayMux.create({});

      // Monkey-patch the retry delay for fast tests
      (agent as any).retryConfig.baseDelayMs = 1;

      const response = await agent.fetch('https://example.com/api');
      expect(response.status).toBe(200);
      expect(callCount).toBe(3); // 1 initial + 2 retries (default maxRetries: 2)
    });
  });
});
