import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/common/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/common/domain-error';

describe('Money Value Object', () => {
  it('should create valid money from string amount and currency', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(money.amount).toBe('25.00');
    expect(money.currency).toBe('BRL');
    expect(money.toString()).toBe('25.00 BRL');
  });

  it('should normalize amounts with fewer decimal places to 2 decimal places', () => {
    const m1 = Money.from({ amount: '25', currency: 'BRL' });
    expect(m1.amount).toBe('25.00');

    const m2 = Money.from({ amount: '25.5', currency: 'BRL' });
    expect(m2.amount).toBe('25.50');
  });

  it('should reject invalid amount inputs', () => {
    const invalidInputs = [
      '',
      '   ',
      'abc',
      '25.000',      // more than 2 decimals
      '25.1234',
      '1e5',         // scientific notation
      '2E10',
      'NaN',
      'Infinity',
      '-25.00',      // negative input
      '25,00',       // comma
    ];

    for (const input of invalidInputs) {
      expect(() => Money.from({ amount: input, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
  });

  it('should reject invalid currency codes', () => {
    expect(() => Money.from({ amount: '25.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '25.00', currency: 'BR' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '25.00', currency: 'BRL1' })).toThrow(InvalidMoneyError);
  });

  it('should add money of same currency', () => {
    const m1 = Money.from({ amount: '25.50', currency: 'BRL' });
    const m2 = Money.from({ amount: '10.25', currency: 'BRL' });
    const result = m1.add(m2);

    expect(result.amount).toBe('35.75');
    expect(result.currency).toBe('BRL');
    // Immutability: original values unchanged
    expect(m1.amount).toBe('25.50');
    expect(m2.amount).toBe('10.25');
  });

  it('should subtract money of same currency', () => {
    const m1 = Money.from({ amount: '50.00', currency: 'BRL' });
    const m2 = Money.from({ amount: '20.25', currency: 'BRL' });
    const result = m1.subtract(m2);

    expect(result.amount).toBe('29.75');
    expect(result.currency).toBe('BRL');
  });

  it('should compare money values correctly', () => {
    const m1 = Money.from({ amount: '50.00', currency: 'BRL' });
    const m2 = Money.from({ amount: '100.00', currency: 'BRL' });
    const m3 = Money.from({ amount: '50.00', currency: 'BRL' });

    expect(m1.isLessThan(m2)).toBe(true);
    expect(m2.isLessThan(m1)).toBe(false);
    expect(m1.equals(m3)).toBe(true);
    expect(m1.equals(m2)).toBe(false);
  });

  it('should throw CurrencyMismatchError on operations between different currencies', () => {
    const brl = Money.from({ amount: '50.00', currency: 'BRL' });
    const usd = Money.from({ amount: '50.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  it('should support zero and negate operations', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.amount).toBe('0.00');

    const m = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(m.isPositive()).toBe(true);
    expect(m.isNegative()).toBe(false);

    const negated = m.negate();
    expect(negated.isNegative()).toBe(true);
    expect(negated.amount).toBe('-25.00');
  });
});
