import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../src/domain/wallet/wallet';
import { Money } from '../../src/domain/common/money';
import { CurrencyMismatchError, InsufficientFundsError } from '../../src/domain/common/domain-error';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';

describe('Wallet Aggregate Root', () => {
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

  it('should open wallet with initial balance and version 1', () => {
    const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
    });

    expect(wallet.id).toBe(walletId);
    expect(wallet.playerId).toBe(playerId);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toBeDefined();
    expect(wallet.updatedAt).toBeDefined();
  });

  it('should credit wallet and produce balanced ledger entry', () => {
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    const entry = wallet.credit(
      Money.from({ amount: '25.00', currency: 'BRL' }),
      'tx-1',
      'ledger-1',
    );

    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.money.amount).toBe('25.00');
    expect(entry.balanceBefore.amount).toBe('50.00');
    expect(entry.balanceAfter.amount).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('should debit wallet and produce balanced ledger entry', () => {
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const entry = wallet.debit(
      Money.from({ amount: '40.00', currency: 'BRL' }),
      'tx-2',
      'ledger-2',
    );

    expect(wallet.balance.amount).toBe('60.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('60.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('should throw InsufficientFundsError when debit exceeds balance', () => {
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(() =>
      wallet.debit(
        Money.from({ amount: '100.01', currency: 'BRL' }),
        'tx-fail',
        'ledger-fail',
      ),
    ).toThrow(InsufficientFundsError);

    // Balance and version must remain unchanged
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('should throw CurrencyMismatchError on credit or debit with different currency', () => {
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => wallet.debit(usd, 'tx-3', 'ledger-3')).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, 'tx-4', 'ledger-4')).toThrow(CurrencyMismatchError);
  });
});
