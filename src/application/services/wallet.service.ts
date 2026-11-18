import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { CreateWalletDto } from '../dto/create-wallet.dto';
import { ConflictError, NotFoundError } from '../errors/application-error';
import { Wallet } from '../../domain/wallet/wallet';
import { Money } from '../../domain/common/money';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wagering/wager-transaction';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/wallet/wallet-ledger-entry';
import { WalletBalanceChanged } from '../../domain/messaging/events/wallet-balance-changed.event';
import { WagerTransactionProcessed } from '../../domain/messaging/events/wager-transaction-processed.event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WalletEntity } from '../../infrastructure/database/entities/wallet.entity';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity';
import { WalletLedgerEntity } from '../../infrastructure/database/entities/wallet-ledger.entity';
import { OutboxEntity } from '../../infrastructure/database/entities/outbox.entity';
import { WalletMapper } from '../../infrastructure/database/mappers/wallet.mapper';
import { WagerTransactionMapper } from '../../infrastructure/database/mappers/wager-transaction.mapper';
import { WalletLedgerMapper } from '../../infrastructure/database/mappers/wallet-ledger.mapper';
import { OutboxMapper } from '../../infrastructure/database/mappers/outbox.mapper';
import { MetricsService } from '../../observability/metrics.service';

export interface LedgerPaginationResult {
  entries: Array<{
    id: string;
    transactionId: string;
    direction: string;
    amount: string;
    currency: string;
    balanceBefore: string;
    balanceAfter: string;
    createdAt: string;
  }>;
  nextCursor?: string;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly metricsService: MetricsService,
  ) {}

  public async openWallet(dto: CreateWalletDto): Promise<{
    id: string;
    playerId: string;
    balance: { amount: string; currency: string };
    version: number;
  }> {
    return await this.em.transactional(async (em) => {
      const existing = await em.findOne(WalletEntity, {
        playerId: dto.playerId,
        currency: dto.initialBalance.currency,
      });

      if (existing) {
        throw new ConflictError(
          `Wallet already exists for player ${dto.playerId} and currency ${dto.initialBalance.currency}`,
        );
      }

      const walletId = randomUUID();
      const initialMoney = Money.from(dto.initialBalance);
      const wallet = Wallet.open({
        id: walletId,
        playerId: dto.playerId,
        initialBalance: initialMoney,
      });

      const walletEntity = WalletMapper.toEntity(wallet);
      em.persist(walletEntity);
      await em.flush?.();

      // If initial balance > 0, generate internal OPENING transaction and ledger entry
      if (initialMoney.isPositive()) {
        const txId = randomUUID();
        const ledgerId = randomUUID();
        const now = new Date();

        const openingTx = WagerTransaction.create({
          id: txId,
          providerId: 'INTERNAL',
          externalTransactionId: `OPENING-${walletId}`,
          idempotencyKey: `INTERNAL:OPENING-${walletId}`,
          payloadHash: 'INTERNAL_OPENING',
          walletId,
          playerId: dto.playerId,
          roundId: 'INTERNAL_OPENING',
          gameId: 'INTERNAL_OPENING',
          kind: WagerTransactionKind.Opening,
          money: initialMoney,
          createdAt: now,
        });
        openingTx.markProcessed(undefined, now);

        const txEntity = WagerTransactionMapper.toEntity(openingTx, initialMoney);
        em.persist(txEntity);
        await em.flush?.();

        const ledgerEntry = WalletLedgerEntry.create({
          id: ledgerId,
          walletId,
          transactionId: txId,
          direction: LedgerDirection.Credit,
          money: initialMoney,
          balanceBefore: Money.zero(initialMoney.currency),
          balanceAfter: initialMoney,
          createdAt: now,
        });

        const ledgerEntity = WalletLedgerMapper.toEntity(ledgerEntry);

        const eventCtx = { correlationId: randomUUID() };
        const balanceChangedEvent = WalletBalanceChanged.from(wallet, ledgerEntry, eventCtx);
        const txProcessedEvent = WagerTransactionProcessed.from(openingTx, eventCtx);

        const outbox1 = OutboxMessage.enqueue(balanceChangedEvent);
        const outbox2 = OutboxMessage.enqueue(txProcessedEvent);

        em.persist(ledgerEntity);
        em.persist(OutboxMapper.toEntity(outbox1));
        em.persist(OutboxMapper.toEntity(outbox2));
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  public async getWallet(walletId: string): Promise<{
    id: string;
    playerId: string;
    currency: string;
    balance: { amount: string; currency: string };
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }> {
    const entity = await this.em.findOne(WalletEntity, { id: walletId });
    if (!entity) {
      throw new NotFoundError(`Wallet ${walletId} not found`);
    }

    const domain = WalletMapper.toDomain(entity);
    return {
      id: domain.id,
      playerId: domain.playerId,
      currency: domain.currency,
      balance: domain.balance.toJSON(),
      version: domain.version,
      createdAt: domain.createdAt,
      updatedAt: domain.updatedAt,
    };
  }

  public async getLedger(
    walletId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<LedgerPaginationResult> {
    const walletExists = await this.em.findOne(WalletEntity, { id: walletId });
    if (!walletExists) {
      throw new NotFoundError(`Wallet ${walletId} not found`);
    }

    const take = Math.min(Math.max(limit, 1), 100);
    const qb = this.em.createQueryBuilder(WalletLedgerEntity, 'l');
    qb.where({ walletId });

    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        const cursorDate = new Date(decoded.createdAt);
        qb.andWhere(
          '(l.created_at < ? OR (l.created_at = ? AND l.id < ?))',
          [cursorDate, cursorDate, decoded.id],
        );
      } catch {
        // Invalid cursor ignored or treated as start
      }
    }

    qb.orderBy({ createdAt: 'DESC', id: 'DESC' });
    qb.limit(take + 1);

    const rows = await qb.getResultList();
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    let nextCursor: string | undefined;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
      ).toString('base64');
    }

    return {
      entries: items.map((r) => ({
        id: r.id,
        transactionId: r.transactionId,
        direction: r.direction,
        amount: r.amount,
        currency: r.currency,
        balanceBefore: r.balanceBefore,
        balanceAfter: r.balanceAfter,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }

  public async reconcileWallet(walletId: string): Promise<ReconciliationResult> {
    const walletEntity = await this.em.findOne(WalletEntity, { id: walletId });
    if (!walletEntity) {
      throw new NotFoundError(`Wallet ${walletId} not found`);
    }

    const entries = await this.em.find(
      WalletLedgerEntity,
      { walletId },
      { orderBy: { createdAt: 'ASC', id: 'ASC' } },
    );

    let calculated = new Decimal('0.00');
    for (const entry of entries) {
      const amt = new Decimal(entry.amount);
      if (entry.direction === LedgerDirection.Credit) {
        calculated = calculated.plus(amt);
      } else if (entry.direction === LedgerDirection.Debit) {
        calculated = calculated.minus(amt);
      }
    }

    const stored = new Decimal(walletEntity.balance);
    const diff = stored.minus(calculated);
    const consistent = diff.isZero();

    if (!consistent) {
      this.metricsService.recordReconciliationDivergence();
      this.logger.warn({
        event: 'ReconciliationDivergenceDetected',
        walletId,
        storedBalance: stored.toFixed(2),
        calculatedBalance: calculated.toFixed(2),
        difference: diff.toFixed(2),
        checkedEntries: entries.length,
      });
    }

    return {
      walletId,
      storedBalance: { amount: stored.toFixed(2), currency: walletEntity.currency },
      calculatedBalance: { amount: calculated.toFixed(2), currency: walletEntity.currency },
      difference: { amount: diff.toFixed(2), currency: walletEntity.currency },
      consistent,
      checkedEntries: entries.length,
    };
  }
}
