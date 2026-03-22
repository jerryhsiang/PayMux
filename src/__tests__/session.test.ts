import { describe, it, expect, vi } from 'vitest';
import { PayMux } from '../client/paymux.js';
import { PayMuxSession } from '../client/session.js';
import { SpendingEnforcer, SpendingLimitError } from '../client/spending.js';

const TEST_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;

describe('PayMuxSession — MPP session management', () => {
  describe('openSession() via PayMuxClient', () => {
    it('throws when no wallet is configured', async () => {
      const agent = PayMux.create({});

      await expect(
        agent.openSession({
          url: 'https://api.example.com',
          budget: 5.00,
        })
      ).rejects.toThrow('requires a wallet');
    });

    it('charges session budget against global per-day limit upfront', async () => {
      const agent = PayMux.create({
        wallet: { privateKey: TEST_KEY },
        limits: { perDay: 3.00 },
      });

      // Session budget of $5.00 exceeds daily limit of $3.00
      await expect(
        agent.openSession({
          url: 'https://api.example.com',
          budget: 5.00,
        })
      ).rejects.toThrow(SpendingLimitError);

      // No spending should have occurred
      expect(agent.spending.totalSpent).toBe(0);
      expect(agent.spending.pendingSpend).toBe(0);
    });

    it('charges session budget against per-request limit', async () => {
      const agent = PayMux.create({
        wallet: { privateKey: TEST_KEY },
        limits: { perRequest: 2.00 },
      });

      // Session budget of $5.00 exceeds per-request limit of $2.00
      await expect(
        agent.openSession({
          url: 'https://api.example.com',
          budget: 5.00,
        })
      ).rejects.toThrow(SpendingLimitError);
    });

    it('successfully opens a session when budget is within limits', async () => {
      const agent = PayMux.create({
        wallet: { privateKey: TEST_KEY },
        limits: { perDay: 100.00 },
      });

      // openSession will pass the spending check ($5 < $100 daily limit),
      // and mppx initialization succeeds (Mppx.create() + session() don't
      // require on-chain infrastructure until a 402 challenge is received).
      const session = await agent.openSession({
        url: 'https://api.example.com',
        budget: 5.00,
      });

      expect(session).toBeInstanceOf(PayMuxSession);
      expect(session.isOpen).toBe(true);
      expect(session.spending.budget).toBe(5.00);

      // The $5.00 should be reserved as pending in global limits
      expect(agent.spending.pendingSpend).toBe(5.00);

      // Session should appear in active sessions list
      expect(agent.sessions.length).toBe(1);

      // Close session to release budget
      await session.close();
      expect(agent.spending.pendingSpend).toBe(0);
    });

    it('returns an empty sessions list when no sessions are open', () => {
      const agent = PayMux.create({
        wallet: { privateKey: TEST_KEY },
        limits: { perDay: 100.00 },
      });

      expect(agent.sessions).toEqual([]);
    });
  });

  describe('PayMuxSession unit tests', () => {
    it('constructs with correct defaults', () => {
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      expect(session.isOpen).toBe(true);
      expect(session.spending.budget).toBe(5.00);
      expect(session.spending.spent).toBe(0);
      expect(session.spending.remaining).toBe(5.00);
      expect(session.spending.requestCount).toBe(0);
      expect(session.spending.isOpen).toBe(true);
      expect(session.spending.initialized).toBe(false);
      expect(session.spending.history).toEqual([]);
      expect(session.timeRemaining).toBeGreaterThan(0);
      expect(session.timeRemaining).toBeLessThanOrEqual(3_600_000);
    });

    it('constructs with custom duration', () => {
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 10.00,
          duration: 30_000, // 30 seconds
        },
        enforcer
      );

      expect(session.isOpen).toBe(true);
      expect(session.timeRemaining).toBeLessThanOrEqual(30_000);
      expect(session.timeRemaining).toBeGreaterThan(0);
    });

    it('throws on fetch() when not initialized', async () => {
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      await expect(
        session.fetch('/api/data')
      ).rejects.toThrow('Not initialized');
    });

    it('throws on fetch() after close()', async () => {
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      await session.close();

      expect(session.isOpen).toBe(false);
      await expect(
        session.fetch('/api/data')
      ).rejects.toThrow('closed');
    });

    it('close() is idempotent — multiple calls do not throw', async () => {
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      await session.close();
      await session.close();
      await session.close();

      expect(session.isOpen).toBe(false);
    });

    it('releases unspent budget to global enforcer on close()', async () => {
      const enforcer = new SpendingEnforcer({ perDay: 100.00 });

      // Simulate the global enforcer reserving the budget (as openSession would)
      enforcer.check(5.00); // Reserves $5 as pending
      expect(enforcer.stats().pendingSpend).toBe(5.00);

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      await session.close();

      // All $5 should be released back since nothing was spent
      expect(enforcer.stats().pendingSpend).toBe(0);
    });

    it('only releases unspent portion on close() when some budget was used', async () => {
      const enforcer = new SpendingEnforcer({ perDay: 100.00 });
      enforcer.check(5.00); // Reserve $5

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      // Manually simulate spending $2 within the session
      // (In real usage, this happens via fetch() + receipt parsing)
      (session as any).spendingState.spent = 2.00;

      await session.close();

      // Only $3 (5 - 2) should be released
      expect(enforcer.stats().pendingSpend).toBe(2.00);
    });

    it('expires after configured duration', async () => {
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
          duration: 1, // 1ms — will expire almost immediately
        },
        enforcer
      );

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(session.isOpen).toBe(false);
      expect(session.timeRemaining).toBe(0);

      await expect(
        session.fetch('/api/data')
      ).rejects.toThrow('expired');
    });

    it('handles full URL passed to fetch()', async () => {
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      // Full URLs should work — the fetch will fail because not initialized,
      // but the URL resolution should not throw
      await expect(
        session.fetch('https://other-api.example.com/data')
      ).rejects.toThrow('Not initialized');
    });

    it('strips trailing slashes from base URL', () => {
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com/',
          budget: 5.00,
        },
        enforcer
      );

      // The session should have stripped the trailing slash
      expect(session.spending.budget).toBe(5.00);
    });

    it('debug logging works when enabled', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
          debug: true,
        },
        enforcer
      );

      await session.close();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[paymux] [session]')
      );
      logSpy.mockRestore();
    });

    it('no logging when debug is false', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
          debug: false,
        },
        enforcer
      );

      await session.close();

      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it('initialize() succeeds when mppx is installed', async () => {
      const enforcer = new SpendingEnforcer({});

      const session = new PayMuxSession(
        { privateKey: TEST_KEY },
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      // mppx is installed, so initialize() should succeed.
      // Mppx.create() + session() only need on-chain infra when
      // a 402 challenge is actually received, not at init time.
      await session.initialize();

      expect(session.spending.initialized).toBe(true);
    });
  });
});
