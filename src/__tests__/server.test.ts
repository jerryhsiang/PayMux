import { describe, it, expect } from 'vitest';
import { PayMuxServer } from '../server/paymux-server.js';
import { toBaseUnits, formatAmount } from '../server/utils.js';

describe('PayMuxServer', () => {
  describe('create() validation', () => {
    it('requires at least one protocol in accept[]', () => {
      expect(() => PayMuxServer.create({ accept: [] })).toThrow('at least one protocol');
    });

    it('requires x402 config when x402 in accept[]', () => {
      expect(() => PayMuxServer.create({ accept: ['x402'] })).toThrow('x402 config is missing');
    });

    it('requires mpp config when mpp in accept[]', () => {
      expect(() => PayMuxServer.create({ accept: ['mpp'] })).toThrow('mpp config is missing');
    });

    it('requires mpp.secretKey when mpp configured', () => {
      expect(() => PayMuxServer.create({
        accept: ['mpp'],
        mpp: { tempoRecipient: '0x01' } as any,
      })).toThrow('secretKey is required');
    });

    it('rejects non-HTTPS facilitator URL', () => {
      expect(() => PayMuxServer.create({
        accept: ['x402'],
        x402: { recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18', facilitator: 'http://evil.com' },
      })).toThrow('must use HTTPS');
    });

    it('rejects x402.recipient that is too short', () => {
      expect(() => PayMuxServer.create({
        accept: ['x402'],
        x402: { recipient: '0xDEAD' as `0x${string}` },
      })).toThrow('not a valid Ethereum address');
    });

    it('rejects x402.recipient that is a placeholder like 0xYourWalletAddress', () => {
      expect(() => PayMuxServer.create({
        accept: ['x402'],
        x402: { recipient: '0xYourWalletAddress' as `0x${string}` },
      })).toThrow('not a valid Ethereum address');
    });

    it('rejects x402.recipient that is the zero address', () => {
      expect(() => PayMuxServer.create({
        accept: ['x402'],
        x402: { recipient: '0x0000000000000000000000000000000000000000' },
      })).toThrow('placeholder address (zero address)');
    });

    it('rejects mpp.tempoRecipient that is a placeholder', () => {
      expect(() => PayMuxServer.create({
        accept: ['mpp'],
        mpp: { secretKey: 'dGVzdC1rZXktdGhhdC1pcy1sb25nLWVub3VnaC1mb3ItaG1hYw==', tempoRecipient: '0xYourWalletAddress' as `0x${string}` },
      })).toThrow('not a valid Ethereum address');
    });

    it('rejects mpp.tempoRecipient that is too short', () => {
      expect(() => PayMuxServer.create({
        accept: ['mpp'],
        mpp: { secretKey: 'dGVzdC1rZXktdGhhdC1pcy1sb25nLWVub3VnaC1mb3ItaG1hYw==', tempoRecipient: '0xABC' as `0x${string}` },
      })).toThrow('not a valid Ethereum address');
    });

    it('accepts a valid Ethereum address for x402.recipient', () => {
      const payments = PayMuxServer.create({
        accept: ['x402'],
        x402: { recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18' },
      });
      expect(payments.protocols).toEqual(['x402']);
    });

    it('creates instance with valid x402 config', () => {
      const payments = PayMuxServer.create({
        accept: ['x402'],
        x402: { recipient: '0x0000000000000000000000000000000000000001', chain: 'base-sepolia' },
      });
      expect(payments.protocols).toEqual(['x402']);
    });

    it('rejects unknown chain name', () => {
      expect(() => PayMuxServer.create({
        accept: ['x402'],
        x402: { recipient: '0x0000000000000000000000000000000000000001', chain: 'ethereum-goerli' },
      })).toThrow('Unknown chain "ethereum-goerli"');
    });

    it('rejects misspelled chain name', () => {
      expect(() => PayMuxServer.create({
        accept: ['x402'],
        x402: { recipient: '0x0000000000000000000000000000000000000001', chain: 'bse' },
      })).toThrow('Unknown chain "bse"');
    });

    it('accepts CAIP-2 eip155 chain format', () => {
      const payments = PayMuxServer.create({
        accept: ['x402'],
        x402: { recipient: '0x0000000000000000000000000000000000000001', chain: 'eip155:8453' },
      });
      expect(payments.protocols).toEqual(['x402']);
    });

    it('accepts named chains: base, base-sepolia, polygon, solana', () => {
      for (const chain of ['base', 'base-sepolia', 'polygon', 'solana'] as const) {
        const payments = PayMuxServer.create({
          accept: ['x402'],
          x402: { recipient: '0x0000000000000000000000000000000000000001', chain },
        });
        expect(payments.protocols).toEqual(['x402']);
      }
    });

    it('creates instance with valid x402 + mpp config', () => {
      const payments = PayMuxServer.create({
        accept: ['x402', 'mpp'],
        x402: { recipient: '0x0000000000000000000000000000000000000001' },
        mpp: { secretKey: 'dGVzdC1rZXktdGhhdC1pcy1sb25nLWVub3VnaC1mb3ItaG1hYw==', tempoRecipient: '0x0000000000000000000000000000000000000002' },
      });
      expect(payments.protocols).toEqual(['x402', 'mpp']);
    });
  });

  describe('charge() validation', () => {
    let payments: ReturnType<typeof PayMuxServer.create>;

    beforeAll(() => {
      payments = PayMuxServer.create({
        accept: ['x402'],
        x402: { recipient: '0x0000000000000000000000000000000000000001' },
      });
    });

    it('rejects negative amount', () => {
      expect(() => payments.charge({ amount: -1 })).toThrow('positive, finite');
    });

    it('rejects zero amount', () => {
      expect(() => payments.charge({ amount: 0 })).toThrow('positive, finite');
    });

    it('rejects NaN amount', () => {
      expect(() => payments.charge({ amount: NaN })).toThrow('positive, finite');
    });

    it('rejects Infinity amount', () => {
      expect(() => payments.charge({ amount: Infinity })).toThrow('positive, finite');
    });

    it('accepts valid amount and returns middleware function', () => {
      const mw = payments.charge({ amount: 0.01, currency: 'USD' });
      expect(typeof mw).toBe('function');
    });
  });

  describe('config immutability', () => {
    it('freezes config so external mutation has no effect', () => {
      const config = {
        accept: ['x402' as const],
        x402: { recipient: '0x0000000000000000000000000000000000000001' as const },
      };
      const payments = PayMuxServer.create(config);

      // Try to mutate the original config
      try { config.accept.push('mpp'); } catch { /* frozen */ }

      // PayMuxServer should still have the original config
      expect(payments.protocols).toEqual(['x402']);
    });
  });
});

describe('toBaseUnits', () => {
  it('converts 0.01 USD to 10000 base units (6 decimals)', () => {
    expect(toBaseUnits(0.01)).toBe('10000');
  });

  it('converts 1.00 USD to 1000000 base units', () => {
    expect(toBaseUnits(1.00)).toBe('1000000');
  });

  it('converts 1.50 USD to 1500000 base units', () => {
    expect(toBaseUnits(1.50)).toBe('1500000');
  });

  it('converts 0.001 USD to 1000 base units', () => {
    expect(toBaseUnits(0.001)).toBe('1000');
  });

  it('converts 0 to "0"', () => {
    expect(toBaseUnits(0)).toBe('0');
  });

  it('handles floating-point precision (0.1 * 10^6 should be 100000)', () => {
    // 0.1 * 1000000 = 100000.00000000001 in JS — toBaseUnits must handle this
    expect(toBaseUnits(0.1)).toBe('100000');
  });

  it('handles very small amounts', () => {
    expect(toBaseUnits(0.000001)).toBe('1');
  });

  it('handles large amounts', () => {
    expect(toBaseUnits(1000)).toBe('1000000000');
  });

  it('handles custom decimal places', () => {
    expect(toBaseUnits(0.01, 2)).toBe('1');
    expect(toBaseUnits(0.01, 8)).toBe('1000000');
    expect(toBaseUnits(1.5, 18)).toBe('1500000000000000000');
  });
});

describe('formatAmount', () => {
  it('formats normal numbers', () => {
    expect(formatAmount(0.01)).toBe('0.01');
    expect(formatAmount(1.5)).toBe('1.5');
    expect(formatAmount(100)).toBe('100');
  });

  it('avoids scientific notation for very small numbers', () => {
    const result = formatAmount(0.0000001);
    expect(result).not.toContain('e');
    expect(result).not.toContain('E');
  });
});

// import at top level for beforeAll
import { beforeAll } from 'vitest';
