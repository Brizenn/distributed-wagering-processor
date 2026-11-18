import { describe, expect, it, beforeEach } from 'bun:test';
import { WagerTransactionService } from '../../src/application/services/wager-transaction.service';
import { IdempotencyService } from '../../src/application/services/idempotency.service';
import { WalletEntity } from '../../src/infrastructure/database/entities/wallet.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { WalletLedgerEntity } from '../../src/infrastructure/database/entities/wallet-ledger.entity';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { MetricsService } from '../../src/observability/metrics.service';
import Decimal from 'decimal.js';

describe('Concurrency & Race Condition Scenarios', () => {
  let wallets: Map<string, WalletEntity>;
  let transactions: Map<string, WagerTransactionEntity>;
  let ledgerEntries: WalletLedgerEntity[];
  let idempotencyService: IdempotencyService;

  // Unit-level simulation of PostgreSQL transaction/advisory/row locks.
  const walletLocks = new Map<string, Promise<void>>();

  function acquireLock(walletId: string): Promise<() => void> {
    let release: () => void;
    const currentLock = walletLocks.get(walletId) || Promise.resolve();
    const newLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    walletLocks.set(walletId, currentLock.then(() => newLock));

    return currentLock.then(() => release);
  }

  function createMockEm() {
    const makeTransactionEm = (releases: Array<() => void>, held: Set<string>) => {
      const acquire = async (key: string) => {
        if (held.has(key)) return;
        held.add(key);
        releases.push(await acquireLock(key));
      };
      const em: any = {
        getConnection: () => ({
          execute: async (_query: string, params: string[]) => {
            await acquire(`advisory:${params[0]}`);
            return [];
          },
        }),
        transactional: async (callback: any) => callback(em),
        findOne: async (entityClass: any, filter: any, options?: any) => {
          if (entityClass === WalletEntity) {
            if (options?.lockMode) await acquire(`wallet:${filter.id}`);
            const w = wallets.get(filter.id);
            if (!w) return null;
            const clone = new WalletEntity();
            Object.assign(clone, w);
            return clone;
          }
          if (entityClass === WagerTransactionEntity) {
            if (filter.id) return transactions.get(filter.id) ?? null;
            if (filter.idempotencyKey) {
              return Array.from(transactions.values()).find(
                (t) => t.idempotencyKey === filter.idempotencyKey,
              ) ?? null;
            }
            if (filter.providerId && filter.externalTransactionId) {
              return Array.from(transactions.values()).find(
                (t) => t.providerId === filter.providerId &&
                  t.externalTransactionId === filter.externalTransactionId,
              ) ?? null;
            }
            if (filter.referenceTransactionId) {
              return Array.from(transactions.values()).find(
                (t) => t.referenceTransactionId === filter.referenceTransactionId &&
                  t.kind === filter.kind && t.status === filter.status,
              ) ?? null;
            }
          }
          return null;
        },
        persist: (entity: any) => {
          if (entity instanceof WalletEntity) wallets.set(entity.id, entity);
          if (entity instanceof WagerTransactionEntity) transactions.set(entity.id, entity);
          if (entity instanceof WalletLedgerEntity) ledgerEntries.push(entity);
        },
        flush: async () => {},
      };
      return em;
    };

    const root: any = {
      fork: () => root,
      transactional: async (callback: any) => {
        const releases: Array<() => void> = [];
        const held = new Set<string>();
        try {
          return await callback(makeTransactionEm(releases, held));
        } finally {
          for (const release of releases.reverse()) release();
        }
      },
    };
    return root;
  }

  beforeEach(() => {
    wallets = new Map();
    transactions = new Map();
    ledgerEntries = [];
    walletLocks.clear();
    idempotencyService = new IdempotencyService();

    const initialWallet = new WalletEntity();
    initialWallet.id = 'wallet-hot-1';
    initialWallet.playerId = 'player-1';
    initialWallet.currency = 'BRL';
    initialWallet.balance = '100.00';
    initialWallet.version = 1;
    initialWallet.createdAt = new Date();
    initialWallet.updatedAt = new Date();
    wallets.set(initialWallet.id, initialWallet);
  });

  /**
   * Section 8 Scenario:
   * Initial balance 100.00 BRL.
   * Two bets of 80.00 BRL processed simultaneously.
   * Expected:
   * - Exactly 1 BET PROCESSED
   * - The other REJECTED by insufficient funds
   * - Final balance 20.00 BRL
   * - Exactly 1 debit entry in ledger
   * - Invariant: wallet.balance === ledger balance sum
   */
  it('Mandatory Section 8: Two simultaneous 80.00 BRL bets on 100.00 BRL wallet', async () => {
    const em1 = createMockEm();
    const em2 = createMockEm();
    const service1 = new WagerTransactionService(em1, idempotencyService, new MetricsService());
    const service2 = new WagerTransactionService(em2, idempotencyService, new MetricsService());

    // Run both bets concurrently
    const bet1Promise = service1.processTransaction({
          providerId: 'provider-a',
          externalTransactionId: 'bet-simul-1',
          playerId: 'player-1',
          walletId: 'wallet-hot-1',
          roundId: 'round-1',
          gameId: 'fortune-tiger',
          kind: WagerTransactionKind.Bet,
          money: { amount: '80.00', currency: 'BRL' },
        });

    const bet2Promise = service2.processTransaction({
          providerId: 'provider-b',
          externalTransactionId: 'bet-simul-2',
          playerId: 'player-1',
          walletId: 'wallet-hot-1',
          roundId: 'round-2',
          gameId: 'fortune-tiger',
          kind: WagerTransactionKind.Bet,
          money: { amount: '80.00', currency: 'BRL' },
        });

    const [result1, result2] = await Promise.all([bet1Promise, bet2Promise]);

    const results = [result1, result2];
    const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);

    // Exactly one bet processed, the other rejected for insufficient funds
    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);

    // Final balance must be exactly 20.00 BRL
    const finalWallet = wallets.get('wallet-hot-1');
    expect(finalWallet?.balance).toBe('20.00');
    expect(finalWallet?.version).toBe(2);

    // Exactly 1 debit entry in ledger
    expect(ledgerEntries.length).toBe(1);
    expect(ledgerEntries[0].amount).toBe('80.00');
    expect(ledgerEntries[0].direction).toBe('DEBIT');
    expect(ledgerEntries[0].balanceAfter).toBe('20.00');

    // Invariant: wallet.balance === ledger balance reconstruction (100 initial - 80 debit = 20)
    let calculated = new Decimal('100.00');
    for (const entry of ledgerEntries) {
      if (entry.direction === 'DEBIT') calculated = calculated.minus(entry.amount);
      if (entry.direction === 'CREDIT') calculated = calculated.plus(entry.amount);
    }
    expect(calculated.toFixed(2)).toBe(finalWallet!.balance);
  });

  /**
   * Section 13 Scenario:
   * The same bet sent 50 times in parallel.
   * Expected:
   * - Exactly one debit
   * - 49 idempotent replays
   * - Balance debited only once
   */
  it('Mandatory Section 13: The same bet sent 50 times in parallel', async () => {
    const mockEm = createMockEm();
    const service = new WagerTransactionService(mockEm, idempotencyService, new MetricsService());

    const betDto = {
      providerId: 'provider-a',
      externalTransactionId: 'bet-repeat-50',
      playerId: 'player-1',
      walletId: 'wallet-hot-1',
      roundId: 'round-repeat',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };

    // Execute 50 requests in parallel
    const promises = Array.from({ length: 50 }, () => service.processTransaction(betDto, {
      idempotencyKey: 'provider-a:bet-repeat-50',
    }));

    const responses = await Promise.all(promises);

    const firstTimeProcessed = responses.filter(
      (r) => r.status === WagerTransactionStatus.Processed && !r.idempotentReplay,
    );
    const replays = responses.filter(
      (r) => r.status === WagerTransactionStatus.Processed && r.idempotentReplay,
    );

    // Exactly one original processed, 49 idempotent replays
    expect(firstTimeProcessed.length).toBe(1);
    expect(replays.length).toBe(49);

    // Balance debited exactly once (100 - 10 = 90)
    const wallet = wallets.get('wallet-hot-1');
    expect(wallet?.balance).toBe('90.00');
    expect(ledgerEntries.length).toBe(1);
  });

  /**
   * Section 13 Scenario:
   * Independent wallets processed in parallel without blocking each other.
   */
  it('Processes distinct wallets concurrently without interference', async () => {
    const w2 = new WalletEntity();
    w2.id = 'wallet-hot-2';
    w2.playerId = 'player-2';
    w2.currency = 'BRL';
    w2.balance = '200.00';
    w2.version = 1;
    w2.createdAt = new Date();
    w2.updatedAt = new Date();
    wallets.set(w2.id, w2);

    const mockEm = createMockEm();
    const service = new WagerTransactionService(mockEm, idempotencyService, new MetricsService());

    const op1 = service.processTransaction({
      providerId: 'prv-1',
      externalTransactionId: 'w1-tx',
      playerId: 'player-1',
      walletId: 'wallet-hot-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '15.00', currency: 'BRL' },
    });

    const op2 = service.processTransaction({
      providerId: 'prv-2',
      externalTransactionId: 'w2-tx',
      playerId: 'player-2',
      walletId: 'wallet-hot-2',
      roundId: 'r-2',
      gameId: 'g-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    const [r1, r2] = await Promise.all([op1, op2]);

    expect(r1.balance.amount).toBe('85.00');
    expect(r2.balance.amount).toBe('150.00');
    expect(wallets.get('wallet-hot-1')?.balance).toBe('85.00');
    expect(wallets.get('wallet-hot-2')?.balance).toBe('150.00');
  });
});
