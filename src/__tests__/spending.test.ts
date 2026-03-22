import { describe, it, expect, beforeEach } from 'vitest';
import { SpendingEnforcer, SpendingLimitError } from '../client/spending.js';

describe('SpendingEnforcer', () => {
  describe('per-request limits', () => {
    it('allows payments within per-request limit', () => {
      const enforcer = new SpendingEnforcer({ perRequest: 1.00 });
      expect(() => enforcer.check(0.50)).not.toThrow();
      expect(() => enforcer.check(1.00)).not.toThrow();
    });

    it('rejects payments exceeding per-request limit', () => {
      const enforcer = new SpendingEnforcer({ perRequest: 1.00 });
      expect(() => enforcer.check(1.01)).toThrow(SpendingLimitError);
      expect(() => enforcer.check(5.00)).toThrow(SpendingLimitError);
    });

    it('throws SpendingLimitError with correct properties', () => {
      const enforcer = new SpendingEnforcer({ perRequest: 0.50 });
      try {
        enforcer.check(1.00);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(SpendingLimitError);
        const err = e as SpendingLimitError;
        expect(err.limitType).toBe('perRequest');
        expect(err.requestedAmount).toBe(1.00);
        expect(err.limit).toBe(0.50);
        expect(err.name).toBe('SpendingLimitError');
      }
    });

    it('allows payments when no per-request limit is set', () => {
      const enforcer = new SpendingEnforcer({});
      expect(() => enforcer.check(1000)).not.toThrow();
    });
  });

  describe('per-day limits', () => {
    it('allows payments within daily limit', () => {
      const enforcer = new SpendingEnforcer({ perDay: 10.00 });
      enforcer.check(5.00);
      enforcer.record(5.00);
      expect(() => enforcer.check(5.00)).not.toThrow();
    });

    it('rejects payments that would exceed daily limit', () => {
      const enforcer = new SpendingEnforcer({ perDay: 10.00 });
      enforcer.check(7.00);
      enforcer.record(7.00);
      expect(() => enforcer.check(4.00)).toThrow(SpendingLimitError);
    });

    it('tracks cumulative daily spend across multiple payments', () => {
      const enforcer = new SpendingEnforcer({ perDay: 5.00 });
      enforcer.check(1.00); enforcer.record(1.00);
      enforcer.check(1.00); enforcer.record(1.00);
      enforcer.check(1.00); enforcer.record(1.00);
      enforcer.check(1.00); enforcer.record(1.00);
      enforcer.check(1.00); enforcer.record(1.00);
      // Now at $5.00, next payment should fail
      expect(() => enforcer.check(0.01)).toThrow(SpendingLimitError);
    });
  });

  describe('concurrency (pending amounts)', () => {
    it('check() reserves amount as pending', () => {
      const enforcer = new SpendingEnforcer({ perDay: 10.00 });
      enforcer.check(6.00); // Reserved, not yet confirmed
      const stats = enforcer.stats();
      expect(stats.pendingSpend).toBe(6.00);
      expect(stats.dailySpend).toBe(0);
      expect(stats.dailyRemaining).toBe(4.00);
    });

    it('concurrent checks include pending in daily limit', () => {
      const enforcer = new SpendingEnforcer({ perDay: 10.00 });
      enforcer.check(6.00); // Pending $6
      // Another concurrent request for $5 should fail (6 pending + 5 = 11 > 10)
      expect(() => enforcer.check(5.00)).toThrow(SpendingLimitError);
    });

    it('record() moves from pending to confirmed', () => {
      const enforcer = new SpendingEnforcer({ perDay: 10.00 });
      enforcer.check(5.00);
      enforcer.record(5.00);
      const stats = enforcer.stats();
      expect(stats.pendingSpend).toBe(0);
      expect(stats.dailySpend).toBe(5.00);
      expect(stats.totalSpent).toBe(5.00);
    });

    it('release() frees pending without confirming', () => {
      const enforcer = new SpendingEnforcer({ perDay: 10.00 });
      enforcer.check(8.00); // Reserve $8
      enforcer.release(8.00); // Payment failed, release
      const stats = enforcer.stats();
      expect(stats.pendingSpend).toBe(0);
      expect(stats.dailySpend).toBe(0);
      expect(stats.dailyRemaining).toBe(10.00);
      // Should be able to use the full daily limit again
      expect(() => enforcer.check(10.00)).not.toThrow();
    });

    it('release() does not go below zero', () => {
      const enforcer = new SpendingEnforcer({});
      enforcer.release(100); // No pending, should not go negative
      expect(enforcer.stats().pendingSpend).toBe(0);
    });
  });

  describe('stats()', () => {
    it('returns correct initial stats', () => {
      const enforcer = new SpendingEnforcer({ perDay: 50.00 });
      const stats = enforcer.stats();
      expect(stats.dailySpend).toBe(0);
      expect(stats.pendingSpend).toBe(0);
      expect(stats.dailyLimit).toBe(50.00);
      expect(stats.dailyRemaining).toBe(50.00);
      expect(stats.totalSpent).toBe(0);
    });

    it('returns undefined for dailyRemaining when no limit set', () => {
      const enforcer = new SpendingEnforcer({});
      expect(enforcer.stats().dailyRemaining).toBeUndefined();
      expect(enforcer.stats().dailyLimit).toBeUndefined();
    });

    it('totalSpent accumulates across multiple payments', () => {
      const enforcer = new SpendingEnforcer({});
      enforcer.check(1.00); enforcer.record(1.00);
      enforcer.check(2.00); enforcer.record(2.00);
      enforcer.check(3.00); enforcer.record(3.00);
      expect(enforcer.stats().totalSpent).toBe(6.00);
    });
  });

  describe('requireApproval', () => {
    it('throws when amount exceeds approval threshold', () => {
      const enforcer = new SpendingEnforcer({ requireApproval: 5.00 });
      expect(() => enforcer.check(6.00)).toThrow(SpendingLimitError);
      try {
        enforcer.check(6.00);
      } catch (e) {
        expect((e as SpendingLimitError).limitType).toBe('requireApproval');
      }
    });

    it('allows amounts at or below threshold', () => {
      const enforcer = new SpendingEnforcer({ requireApproval: 5.00 });
      expect(() => enforcer.check(5.00)).not.toThrow();
      expect(() => enforcer.check(1.00)).not.toThrow();
    });
  });
});
