import { describe, expect, it, beforeEach } from 'bun:test';
import { WagerTransactionService } from '../../src/application/services/wager-transaction.service';
import { IdempotencyService } from '../../src/application/services/idempotency.service';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { ConflictError } from '../../src/application/errors/application-error';
import { WalletEntity } from '../../src/infrastructure/database/entities/wallet.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { MetricsService } from '../../src/observability/metrics.service';

describe('WagerTransactionService (Unit)', () => {
  let service: WagerTransactionService;
  let idempotencyService: IdempotencyService;

  // In-memory simulation of database state
  let wallets: Map<string, WalletEntity>;
  let transactions: Map<string, WagerTransactionEntity>;
  let persistedEntities: any[];

  beforeEach(() => {
    wallets = new Map();
    transactions = new Map();
    persistedEntities = [];

    const mockWallet = new WalletEntity();
    mockWallet.id = 'w-1';
    mockWallet.playerId = 'p-1';
    mockWallet.currency = 'BRL';
    mockWallet.balance = '100.00';
    mockWallet.version = 1;
    mockWallet.createdAt = new Date();
    mockWallet.updatedAt = new Date();
    wallets.set('w-1', mockWallet);

    const mockEm: any = {
      flush: async () => {},
      transactional: async (cb: any) => cb(mockEm),
      getConnection: () => ({ execute: async () => [] }),
      findOne: async (entityClass: any, filter: any) => {
        if (entityClass === WalletEntity) {
          return wallets.get(filter.id) ?? null;
        }
        if (entityClass === WagerTransactionEntity) {
          if (filter.id) {
            return transactions.get(filter.id) ?? null;
          }
          if (filter.idempotencyKey) {
            return Array.from(transactions.values()).find(
              (t) => t.idempotencyKey === filter.idempotencyKey,
            ) ?? null;
          }
          if (filter.providerId && filter.externalTransactionId) {
            return (
              Array.from(transactions.values()).find(
                (t) =>
                  t.providerId === filter.providerId &&
                  t.externalTransactionId === filter.externalTransactionId,
              ) ?? null
            );
          }
          if (filter.referenceTransactionId) {
            return (
              Array.from(transactions.values()).find(
                (t) =>
                  t.referenceTransactionId === filter.referenceTransactionId &&
                  t.kind === filter.kind &&
                  t.status === filter.status,
              ) ?? null
            );
          }
        }
        return null;
      },
      persist: (e: any) => {
        persistedEntities.push(e);
        if (e instanceof WalletEntity) {
          wallets.set(e.id, e);
        }
        if (e instanceof WagerTransactionEntity) {
          transactions.set(e.id, e);
        }
      },
    };

    idempotencyService = new IdempotencyService();
    service = new WagerTransactionService(mockEm, idempotencyService, new MetricsService());
  });

  it('should process a valid BET and decrease balance', async () => {
    const result = await service.processTransaction({
      providerId: 'provider-1',
      externalTransactionId: 'tx-1',
      playerId: 'p-1',
      walletId: 'w-1',
      roundId: 'round-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('70.00');
    expect(result.idempotentReplay).toBe(false);

    const updatedWallet = wallets.get('w-1');
    expect(updatedWallet?.balance).toBe('70.00');
    expect(updatedWallet?.version).toBe(2);
  });

  it('should reject BET with INSUFFICIENT_FUNDS when balance is inadequate', async () => {
    const result = await service.processTransaction({
      providerId: 'provider-1',
      externalTransactionId: 'tx-2',
      playerId: 'p-1',
      walletId: 'w-1',
      roundId: 'round-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '150.00', currency: 'BRL' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(result.balance.amount).toBe('100.00'); // Unchanged

    const wallet = wallets.get('w-1');
    expect(wallet?.balance).toBe('100.00');
  });

  it('should process a valid WIN and increase balance', async () => {
    const result = await service.processTransaction({
      providerId: 'provider-1',
      externalTransactionId: 'tx-win-1',
      playerId: 'p-1',
      walletId: 'w-1',
      roundId: 'round-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('150.00');
  });

  it('should process LOSS without altering balance', async () => {
    const result = await service.processTransaction({
      providerId: 'provider-1',
      externalTransactionId: 'tx-loss-1',
      playerId: 'p-1',
      walletId: 'w-1',
      roundId: 'round-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Loss,
      money: { amount: '0.00', currency: 'BRL' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('100.00');
  });

  it('should return idempotent replay when receiving same key and identical payload', async () => {
    const dto = {
      providerId: 'provider-1',
      externalTransactionId: 'tx-replay-1',
      playerId: 'p-1',
      walletId: 'w-1',
      roundId: 'round-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
    };

    const first = await service.processTransaction(dto);
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(first.idempotentReplay).toBe(false);

    // Second request with exact same payload
    const second = await service.processTransaction(dto);
    expect(second.status).toBe(WagerTransactionStatus.Processed);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.idempotentReplay).toBe(true);

    // Balance should have been debited only once (100 - 20 = 80)
    expect(wallets.get('w-1')?.balance).toBe('80.00');
  });

  it('should replay the original balance snapshot after later wallet activity', async () => {
    const bet = {
      providerId: 'provider-1',
      externalTransactionId: 'tx-snapshot-1',
      playerId: 'p-1',
      walletId: 'w-1',
      roundId: 'round-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
    };
    const first = await service.processTransaction(bet);
    await service.processTransaction({
      ...bet,
      externalTransactionId: 'tx-snapshot-win',
      kind: WagerTransactionKind.Win,
      money: { amount: '10.00', currency: 'BRL' },
    });

    const replay = await service.processTransaction(bet);
    expect(first.balance.amount).toBe('80.00');
    expect(replay.balance.amount).toBe('80.00');
    expect(replay.idempotentReplay).toBe(true);
  });

  it('should reject a player id that does not own the wallet', async () => {
    const result = await service.processTransaction({
      providerId: 'provider-1',
      externalTransactionId: 'tx-wrong-player',
      playerId: 'another-player',
      walletId: 'w-1',
      roundId: 'round-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.PLAYER_MISMATCH);
    expect(wallets.get('w-1')?.balance).toBe('100.00');
  });

  it('should throw ConflictError when same idempotency key is reused with different payload', async () => {
    const dto = {
      providerId: 'provider-1',
      externalTransactionId: 'tx-conflict-1',
      playerId: 'p-1',
      walletId: 'w-1',
      roundId: 'round-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
    };

    await service.processTransaction(dto);

    // Same key, different amount!
    const conflictDto = {
      ...dto,
      money: { amount: '50.00', currency: 'BRL' },
    };

    expect(service.processTransaction(conflictDto)).rejects.toThrow(ConflictError);
  });

  it('should mark REFUND as PENDING_REFERENCE when reference transaction is not yet found', async () => {
    const refundDto = {
      providerId: 'provider-1',
      externalTransactionId: 'tx-refund-pending',
      playerId: 'p-1',
      walletId: 'w-1',
      roundId: 'round-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'future-bet-tx',
    };

    const result = await service.processTransaction(refundDto);
    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    // Balance unchanged
    expect(wallets.get('w-1')?.balance).toBe('100.00');
  });
});
