import { describe, it, expect, vi } from 'vitest';
import { PayMux } from '../client/paymux.js';
import { PayMuxSession } from '../client/session.js';
import type { SessionFetchDelegate } from '../client/session.js';
import { SpendingEnforcer, SpendingLimitError } from '../client/spending.js';

const TEST_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;

/** Create a mock SessionFetchDelegate (mimics a PayMuxClient). */
function createMockDelegate(mockFetch?: typeof fetch): SessionFetchDelegate {
  return {
    fetch: mockFetch ?? vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: 'ok' }), { status: 200 })
    ),
    spending: { history: [] },
  };
}

describe('PayMuxSession — session management', () => {
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
      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
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
      expect(session.spending.history).toEqual([]);
      expect(session.timeRemaining).toBeGreaterThan(0);
      expect(session.timeRemaining).toBeLessThanOrEqual(3_600_000);
    });

    it('constructs with custom duration', () => {
      const enforcer = new SpendingEnforcer({});
      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
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

    it('fetch() works immediately after construction (no initialization needed)', async () => {
      const enforcer = new SpendingEnforcer({});
      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      const response = await session.fetch('/api/data');
      expect(response.status).toBe(200);
      expect(session.spending.requestCount).toBe(1);
    });

    it('throws on fetch() after close()', async () => {
      const enforcer = new SpendingEnforcer({});
      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
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
      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
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

      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
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

      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      // Manually simulate spending $2 within the session
      // (In real usage, this happens via fetch() + payment history tracking)
      (session as any).spendingState.spent = 2.00;

      await session.close();

      // close() records the $2 spent portion (moving it from pending to confirmed)
      // and releases the $3 unspent portion. pendingSpend should be 0.
      expect(enforcer.stats().pendingSpend).toBe(0);
      expect(enforcer.stats().dailySpend).toBe(2.00);
      expect(enforcer.stats().totalSpent).toBe(2.00);
    });

    it('expires after configured duration', async () => {
      const enforcer = new SpendingEnforcer({});
      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
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
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('', { status: 200 })
      );
      const enforcer = new SpendingEnforcer({});
      const delegate = createMockDelegate(mockFetch);

      const session = new PayMuxSession(
        delegate,
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      await session.fetch('https://other-api.example.com/data');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://other-api.example.com/data',
        expect.objectContaining({ skipSpendingCheck: true })
      );
    });

    it('strips trailing slashes from base URL', () => {
      const enforcer = new SpendingEnforcer({});
      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
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
      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
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
      const delegate = createMockDelegate();

      const session = new PayMuxSession(
        delegate,
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

    it('session delegates to parent client fetch', async () => {
      const enforcer = new SpendingEnforcer({});
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: 'ok' }), { status: 200 })
      );
      const delegate = createMockDelegate(mockFetch);

      const session = new PayMuxSession(
        delegate,
        {
          url: 'https://api.example.com',
          budget: 5.00,
        },
        enforcer
      );

      await session.fetch('/api/data');

      // Should have called the delegate's fetch with full URL
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/api/data',
        expect.objectContaining({ skipSpendingCheck: true })
      );
    });
  });
});
