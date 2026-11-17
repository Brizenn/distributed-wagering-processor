import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../src/domain/wallet/wallet';
import { Money } from '../../src/domain/common/money';
import { WalletMapper } from '../../src/infrastructure/database/mappers/wallet.mapper';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionMapper } from '../../src/infrastructure/database/mappers/wager-transaction.mapper';
import { WalletLedgerMapper } from '../../src/infrastructure/database/mappers/wallet-ledger.mapper';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { InboxMapper } from '../../src/infrastructure/database/mappers/inbox.mapper';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { OutboxMapper } from '../../src/infrastructure/database/mappers/outbox.mapper';
import { WalletBalanceChanged } from '../../src/domain/messaging/events/wallet-balance-changed.event';

describe('Persistence Mappers', () => {
  it('should map Wallet between domain and entity with exact precision', () => {
    const domainWallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '1234.56', currency: 'BRL' }),
    });

    const entity = WalletMapper.toEntity(domainWallet);
    expect(entity.id).toBe('w-1');
    expect(entity.balance).toBe('1234.56');
    expect(entity.currency).toBe('BRL');
    expect(entity.version).toBe(1);

    const rehydrated = WalletMapper.toDomain(entity);
    expect(rehydrated.id).toBe(domainWallet.id);
    expect(rehydrated.balance.amount).toBe('1234.56');
    expect(rehydrated.balance.currency).toBe('BRL');
    expect(rehydrated.version).toBe(domainWallet.version);
  });

  it('should map WagerTransaction between domain and entity', () => {
    const domainTx = WagerTransaction.create({
      id: 'tx-1',
      providerId: 'prv-1',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'prv-1:ext-1',
      payloadHash: 'hash-abc',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    const entity = WagerTransactionMapper.toEntity(domainTx);
    expect(entity.id).toBe('tx-1');
    expect(entity.amount).toBe('50.00');
    expect(entity.status).toBe('PENDING');

    const rehydrated = WagerTransactionMapper.toDomain(entity);
    expect(rehydrated.id).toBe(domainTx.id);
    expect(rehydrated.money.amount).toBe('50.00');
    expect(rehydrated.status).toBe(domainTx.status);
  });

  it('should map WalletLedgerEntry between domain and entity', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const entry = wallet.debit(Money.from({ amount: '30.00', currency: 'BRL' }), 'tx-1', 'l-1');

    const entity = WalletLedgerMapper.toEntity(entry);
    expect(entity.id).toBe('l-1');
    expect(entity.amount).toBe('30.00');
    expect(entity.balanceBefore).toBe('100.00');
    expect(entity.balanceAfter).toBe('70.00');

    const rehydrated = WalletLedgerMapper.toDomain(entity);
    expect(rehydrated.id).toBe('l-1');
    expect(rehydrated.money.amount).toBe('30.00');
    expect(rehydrated.isBalanced()).toBe(true);
  });

  it('should map InboxMessage between domain and entity', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'sqs-consumer',
      payloadHash: 'hash-123',
    });

    const entity = InboxMapper.toEntity(inbox);
    expect(entity.messageId).toBe('msg-1');
    expect(entity.consumerName).toBe('sqs-consumer');

    const rehydrated = InboxMapper.toDomain(entity);
    expect(rehydrated.messageId).toBe('msg-1');
    expect(rehydrated.isProcessed()).toBe(false);
  });

  it('should map OutboxMessage between domain and entity', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const entry = wallet.credit(Money.from({ amount: '10.00', currency: 'BRL' }), 'tx-1', 'l-1');
    const event = WalletBalanceChanged.from(wallet, entry, { correlationId: 'corr-1' });

    const outbox = OutboxMessage.enqueue(event);
    const entity = OutboxMapper.toEntity(outbox);

    expect(entity.aggregateId).toBe('w-1');
    expect(entity.eventType).toBe('WalletBalanceChanged');

    const rehydrated = OutboxMapper.toDomain(entity);
    expect(rehydrated.aggregateId).toBe('w-1');
    expect(rehydrated.eventType).toBe('WalletBalanceChanged');
    expect(rehydrated.isPending()).toBe(true);
  });
});
