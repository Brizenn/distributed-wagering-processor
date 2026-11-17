import { describe, expect, it } from 'bun:test';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { WalletBalanceChanged } from '../../src/domain/messaging/events/wallet-balance-changed.event';
import { Wallet } from '../../src/domain/wallet/wallet';
import { Money } from '../../src/domain/common/money';

describe('OutboxMessage Entity', () => {
  it('should enqueue integration event and be immediately due', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const entry = wallet.credit(
      Money.from({ amount: '50.00', currency: 'BRL' }),
      'tx-1',
      'ledger-1',
    );

    const event = WalletBalanceChanged.from(wallet, entry, {
      correlationId: 'corr-1',
    });

    const outbox = OutboxMessage.enqueue(event);

    expect(outbox.aggregateId).toBe('w-1');
    expect(outbox.eventType).toBe('WalletBalanceChanged');
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(new Date())).toBe(true);
    expect(outbox.attempts).toBe(0);
  });

  it('should schedule retry with exponential backoff', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const entry = wallet.debit(
      Money.from({ amount: '10.00', currency: 'BRL' }),
      'tx-1',
      'ledger-1',
    );

    const event = WalletBalanceChanged.from(wallet, entry, {
      correlationId: 'corr-1',
    });

    const outbox = OutboxMessage.enqueue(event);
    const now = new Date();

    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    // 1st retry: 1000ms
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);

    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(2);
    // 2nd retry: 2000ms
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 2000);

    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(3);
    // 3rd retry: 4000ms
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 4000);
  });

  it('should mark published and no longer be pending or due', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const entry = wallet.credit(
      Money.from({ amount: '20.00', currency: 'BRL' }),
      'tx-1',
      'ledger-1',
    );

    const event = WalletBalanceChanged.from(wallet, entry, {
      correlationId: 'corr-1',
    });

    const outbox = OutboxMessage.enqueue(event);
    outbox.markPublished();

    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date())).toBe(false);
    expect(outbox.publishedAt).toBeDefined();
  });
});
