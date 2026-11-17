import { describe, expect, it } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';
import { Money } from '../../src/domain/common/money';
import { LedgerImbalanceError } from '../../src/domain/common/domain-error';

describe('WalletLedgerEntry Entity', () => {
  it('should create valid balanced debit entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'l-1',
      walletId: 'w-1',
      transactionId: 't-1',
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '80.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });

  it('should create valid balanced credit entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'l-2',
      walletId: 'w-1',
      transactionId: 't-2',
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '80.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '130.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('should throw LedgerImbalanceError when balanceBefore ± money !== balanceAfter', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'l-3',
        walletId: 'w-1',
        transactionId: 't-3',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '20.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '70.00', currency: 'BRL' }), // wrong arithmetic!
      }),
    ).toThrow(LedgerImbalanceError);
  });
});
