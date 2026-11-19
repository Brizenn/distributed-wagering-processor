import { Injectable } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { ProcessWagerDto } from '../dto/process-wager.dto';
import { WagerResultDto } from '../dto/wager-result.dto';
import { ConflictError, NotFoundError } from '../errors/application-error';
import { IdempotencyService } from './idempotency.service';
import { Money } from '../../domain/common/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { FailureCode } from '../../domain/wagering/failure-code';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletEntity } from '../../infrastructure/database/entities/wallet.entity';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity';
import { WalletLedgerEntity } from '../../infrastructure/database/entities/wallet-ledger.entity';
import { WalletMapper } from '../../infrastructure/database/mappers/wallet.mapper';
import { WagerTransactionMapper } from '../../infrastructure/database/mappers/wager-transaction.mapper';
import { WalletLedgerMapper } from '../../infrastructure/database/mappers/wallet-ledger.mapper';
import { OutboxMapper } from '../../infrastructure/database/mappers/outbox.mapper';
import { WalletBalanceChanged } from '../../domain/messaging/events/wallet-balance-changed.event';
import { WagerTransactionProcessed } from '../../domain/messaging/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../domain/messaging/events/wager-transaction-rejected.event';
import { WagerTransactionPendingReference } from '../../domain/messaging/events/wager-transaction-pending-reference.event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { MetricsService } from '../../observability/metrics.service';

export interface ProcessTransactionOptions {
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
}

@Injectable()
export class WagerTransactionService {
  constructor(
    private readonly em: EntityManager,
    private readonly idempotencyService: IdempotencyService,
    private readonly metricsService: MetricsService,
  ) {}

  public async processTransaction(
    dto: ProcessWagerDto,
    options: ProcessTransactionOptions = {},
    transactionManager?: EntityManager,
  ): Promise<WagerResultDto> {
    const idempotencyKey =
      options.idempotencyKey ?? `${dto.providerId}:${dto.externalTransactionId}`;
    const correlationId = options.correlationId ?? randomUUID();
    const causationId = options.causationId;

    const execute = (em: EntityManager) =>
      this.processTransactionIn(em, dto, { idempotencyKey, correlationId, causationId });

    return transactionManager ? execute(transactionManager) : this.em.transactional(execute);
  }

  private async processTransactionIn(
    em: EntityManager,
    dto: ProcessWagerDto,
    options: Required<Pick<ProcessTransactionOptions, 'idempotencyKey' | 'correlationId'>> &
      Pick<ProcessTransactionOptions, 'causationId'>,
  ): Promise<WagerResultDto> {
    const { idempotencyKey, correlationId, causationId } = options;
    const eventCtx = { correlationId, causationId };
    const payloadHash = this.idempotencyService.computePayloadHash(dto);

    // Serialize only identical idempotency/business identities. Other operations,
    // including different wallets, remain independent.
    await this.acquireIdempotencyLocks(em, dto, idempotencyKey);

      // 1. Check persistent idempotency
      const existingByKey = await em.findOne(WagerTransactionEntity, { idempotencyKey });
      const existingByExternalId = await em.findOne(WagerTransactionEntity, {
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
      });
      if (existingByKey && existingByExternalId && existingByKey.id !== existingByExternalId.id) {
        throw new ConflictError(
          'Idempotency-Key and provider transaction identity refer to different operations',
          FailureCode.IDEMPOTENCY_PAYLOAD_MISMATCH,
        );
      }
      const existingTxEntity = existingByKey ?? existingByExternalId;

      if (existingTxEntity) {
        const existingTx = WagerTransactionMapper.toDomain(existingTxEntity);

        if (existingTx.idempotencyKey !== idempotencyKey) {
          throw new ConflictError(
            'Provider transaction identity was already accepted with a different Idempotency-Key',
            FailureCode.IDEMPOTENCY_KEY_MISMATCH,
          );
        }

        if (!existingTx.matchesPayload(payloadHash)) {
          throw new ConflictError(
            `Idempotency key "${idempotencyKey}" already used with different payload`,
            FailureCode.IDEMPOTENCY_PAYLOAD_MISMATCH,
          );
        }

        // Replay the exact balance snapshot returned by the original request.
        const walletEntity = await em.findOne(WalletEntity, { id: existingTx.walletId });
        const fallbackBalance = walletEntity
          ? { amount: walletEntity.balance, currency: walletEntity.currency }
          : { amount: '0.00', currency: existingTx.money.currency };
        const resultBalance = existingTxEntity.resultBalanceAmount !== undefined && existingTxEntity.resultBalanceCurrency
          ? {
              amount: existingTxEntity.resultBalanceAmount,
              currency: existingTxEntity.resultBalanceCurrency,
            }
          : fallbackBalance;

        return {
          transactionId: existingTx.id,
          status: existingTx.status,
          balance: resultBalance,
          idempotentReplay: true,
          failureCode: existingTx.failureCode,
        };
      }

      // 2. Lock the wallet using PESSIMISTIC_WRITE (SELECT ... FOR UPDATE)
      // This serializes all concurrent operations for this specific wallet!
      const lockStartedAt = Date.now();
      const walletEntity = await em.findOne(
        WalletEntity,
        { id: dto.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (Date.now() - lockStartedAt >= 25) {
        this.metricsService.recordLockContention();
      }

      if (!walletEntity) {
        throw new NotFoundError(`Wallet ${dto.walletId} not found`);
      }

      const wallet = WalletMapper.toDomain(walletEntity);
      const money = Money.from(dto.money);

      if (wallet.playerId !== dto.playerId) {
        return this.rejectImmediately(
          em,
          dto,
          idempotencyKey,
          payloadHash,
          wallet,
          FailureCode.PLAYER_MISMATCH,
          eventCtx,
        );
      }

      // Verify currency matches
      if (wallet.currency !== money.currency) {
        return this.rejectImmediately(
          em,
          dto,
          idempotencyKey,
          payloadHash,
          wallet,
          FailureCode.CURRENCY_MISMATCH,
          eventCtx,
        );
      }

      // 3. Create domain transaction in PENDING state
      const txId = randomUUID();
      const tx = WagerTransaction.create({
        id: txId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId: dto.walletId,
        playerId: dto.playerId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: dto.kind,
        money,
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
      });

      // 4. Execute operation based on kind
      switch (dto.kind) {
        case WagerTransactionKind.Bet:
          return await this.handleBet(em, wallet, tx, money, eventCtx, walletEntity);

        case WagerTransactionKind.Win:
          return await this.handleWin(em, wallet, tx, money, dto, eventCtx, walletEntity);

        case WagerTransactionKind.Loss:
          return await this.handleLoss(em, wallet, tx, eventCtx);

        case WagerTransactionKind.Refund:
          return await this.handleRefund(em, wallet, tx, money, dto, eventCtx, walletEntity);

        case WagerTransactionKind.Rollback:
          return await this.handleRollback(em, wallet, tx, money, dto, eventCtx, walletEntity);

        default:
          throw new ConflictError(`Unsupported transaction kind: ${dto.kind}`);
      }
  }

  private async acquireIdempotencyLocks(
    em: EntityManager,
    dto: ProcessWagerDto,
    idempotencyKey: string,
  ): Promise<void> {
    const identities = [
      `idempotency:${idempotencyKey}`,
      `provider-transaction:${dto.providerId}:${dto.externalTransactionId}`,
    ].sort();
    const connection = em.getConnection();

    for (const identity of identities) {
      await connection.execute(
        'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
        [identity],
        'all',
        em.getTransactionContext?.(),
      );
    }
  }

  /** Reprocesses an existing PENDING_REFERENCE row in one transaction. */
  public async retryPendingReference(transactionId: string): Promise<boolean> {
    return this.em.transactional((em) => this.retryPendingReferenceIn(em, transactionId));
  }

  private async retryPendingReferenceIn(
    em: EntityManager,
    transactionId: string,
  ): Promise<boolean> {
    const now = new Date();
    const txEntity = await em.findOne(
      WagerTransactionEntity,
      { id: transactionId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!txEntity || txEntity.status !== WagerTransactionStatus.PendingReference) {
      return false;
    }
    const tx = WagerTransactionMapper.toDomain(txEntity);
    const walletEntity = await em.findOne(
      WalletEntity,
      { id: tx.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!walletEntity) {
      throw new NotFoundError(`Wallet ${tx.walletId} not found while retrying transaction ${tx.id}`);
    }
    const wallet = WalletMapper.toDomain(walletEntity);
    const dto: ProcessWagerDto = {
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      playerId: tx.playerId,
      walletId: tx.walletId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
    };

    const ageMs = now.getTime() - txEntity.createdAt.getTime();
    if (wallet.playerId !== tx.playerId || wallet.currency !== tx.money.currency) {
      tx.reject(
        wallet.playerId !== tx.playerId ? FailureCode.PLAYER_MISMATCH : FailureCode.CURRENCY_MISMATCH,
        now,
      );
      this.persistTransaction(em, tx, wallet.balance, txEntity);
      em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(
        WagerTransactionRejected.from(tx, { correlationId: tx.id }),
      )));
      return true;
    }

    const reference = tx.referenceExternalTransactionId
      ? await em.findOne(WagerTransactionEntity, {
          providerId: tx.providerId,
          externalTransactionId: tx.referenceExternalTransactionId,
        })
      : null;

    if (!reference) {
      if (ageMs >= 5 * 60 * 1000) {
        tx.reject(FailureCode.REFERENCE_NOT_FOUND, now);
        this.persistTransaction(em, tx, wallet.balance, txEntity);
        em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(
          WagerTransactionRejected.from(tx, { correlationId: tx.id }),
        )));
        return true;
      }
      if (txEntity.referenceNextAttemptAt && txEntity.referenceNextAttemptAt > now) {
        return false;
      }
      txEntity.referenceAttempts += 1;
      const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(txEntity.referenceAttempts - 1, 6));
      txEntity.referenceNextAttemptAt = new Date(now.getTime() + delayMs);
      this.metricsService.recordRetry();
      await em.flush();
      return false;
    }

    const eventCtx = { correlationId: tx.id };
    switch (tx.kind) {
      case WagerTransactionKind.Win: {
        const result = await this.handleWin(em, wallet, tx, tx.money, dto, eventCtx, walletEntity, txEntity);
        this.metricsService.recordTransactionStatus(result.status);
        return true;
      }
      case WagerTransactionKind.Refund: {
        const result = await this.handleRefund(em, wallet, tx, tx.money, dto, eventCtx, walletEntity, txEntity);
        this.metricsService.recordTransactionStatus(result.status);
        return true;
      }
      case WagerTransactionKind.Rollback: {
        const result = await this.handleRollback(em, wallet, tx, tx.money, dto, eventCtx, walletEntity, txEntity);
        this.metricsService.recordTransactionStatus(result.status);
        return true;
      }
      default:
        tx.reject(FailureCode.INVALID_REFERENCE_KIND, now);
        this.persistTransaction(em, tx, wallet.balance, txEntity);
        em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(
          WagerTransactionRejected.from(tx, eventCtx),
        )));
        this.metricsService.recordTransactionStatus(tx.status);
        return true;
    }
  }

  private persistTransaction(
    em: EntityManager,
    tx: WagerTransaction,
    resultBalance: Money,
    existingEntity?: WagerTransactionEntity,
  ): WagerTransactionEntity {
    const entity = existingEntity
      ? WagerTransactionMapper.updateEntity(tx, existingEntity, resultBalance)
      : WagerTransactionMapper.toEntity(tx, resultBalance);
    em.persist(entity);
    return entity;
  }

  private async handleBet(
    em: EntityManager,
    wallet: Wallet,
    tx: WagerTransaction,
    money: Money,
    eventCtx: { correlationId: string; causationId?: string },
    walletEntity: WalletEntity,
  ): Promise<WagerResultDto> {
    if (wallet.balance.isLessThan(money)) {
      tx.reject(FailureCode.INSUFFICIENT_FUNDS);
      this.persistTransaction(em, tx, wallet.balance);

      const rejectedEvent = WagerTransactionRejected.from(tx, eventCtx);
      em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(rejectedEvent)));

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
        failureCode: tx.failureCode,
      };
    }

    const ledgerId = randomUUID();
    const ledgerEntry = wallet.debit(money, tx.id, ledgerId);
    tx.markProcessed();

    WalletMapper.updateEntity(wallet, walletEntity);
    this.persistTransaction(em, tx, wallet.balance);
    const ledgerEntity = WalletLedgerMapper.toEntity(ledgerEntry);

    em.persist(walletEntity);
    await em.flush?.();

    em.persist(ledgerEntity);

    const balanceChangedEvent = WalletBalanceChanged.from(wallet, ledgerEntry, eventCtx);
    const txProcessedEvent = WagerTransactionProcessed.from(tx, eventCtx);
    em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(balanceChangedEvent)));
    em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(txProcessedEvent)));

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async handleWin(
    em: EntityManager,
    wallet: Wallet,
    tx: WagerTransaction,
    money: Money,
    dto: ProcessWagerDto,
    eventCtx: { correlationId: string; causationId?: string },
    walletEntity: WalletEntity,
    existingTxEntity?: WagerTransactionEntity,
  ): Promise<WagerResultDto> {
    let referenceId: string | undefined;
    if (dto.referenceExternalTransactionId) {
      const referenceEntity = await em.findOne(WagerTransactionEntity, {
        providerId: dto.providerId,
        externalTransactionId: dto.referenceExternalTransactionId,
      });
      if (!referenceEntity) {
        tx.markPendingReference();
        this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
        em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(
          WagerTransactionPendingReference.from(tx, eventCtx),
        )));
        return {
          transactionId: tx.id,
          status: tx.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };
      }

      const reference = WagerTransactionMapper.toDomain(referenceEntity);
      const validationError = this.validateWinReference(dto, wallet, reference);
      if (validationError) {
        tx.reject(validationError);
        this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
        em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(
          WagerTransactionRejected.from(tx, eventCtx),
        )));
        return {
          transactionId: tx.id,
          status: tx.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
          failureCode: tx.failureCode,
        };
      }
      referenceId = reference.id;
    }

    const ledgerId = randomUUID();
    const ledgerEntry = wallet.credit(money, tx.id, ledgerId);
    tx.markProcessed(referenceId);

    WalletMapper.updateEntity(wallet, walletEntity);
    this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
    const ledgerEntity = WalletLedgerMapper.toEntity(ledgerEntry);

    em.persist(walletEntity);
    await em.flush?.();

    em.persist(ledgerEntity);

    const balanceChangedEvent = WalletBalanceChanged.from(wallet, ledgerEntry, eventCtx);
    const txProcessedEvent = WagerTransactionProcessed.from(tx, eventCtx);
    em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(balanceChangedEvent)));
    em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(txProcessedEvent)));

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async handleLoss(
    em: EntityManager,
    wallet: Wallet,
    tx: WagerTransaction,
    eventCtx: { correlationId: string; causationId?: string },
  ): Promise<WagerResultDto> {
    tx.markProcessed();
    this.persistTransaction(em, tx, wallet.balance);

    const txProcessedEvent = WagerTransactionProcessed.from(tx, eventCtx);
    em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(txProcessedEvent)));

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async handleRefund(
    em: EntityManager,
    wallet: Wallet,
    tx: WagerTransaction,
    money: Money,
    dto: ProcessWagerDto,
    eventCtx: { correlationId: string; causationId?: string },
    walletEntity: WalletEntity,
    existingTxEntity?: WagerTransactionEntity,
  ): Promise<WagerResultDto> {
    // Look up referenced transaction
    const refEntity = await em.findOne(WagerTransactionEntity, {
      providerId: dto.providerId,
      externalTransactionId: dto.referenceExternalTransactionId,
    });

    if (!refEntity) {
      // Reference not found yet: persist as PENDING_REFERENCE for background worker
      tx.markPendingReference();
      this.persistTransaction(em, tx, wallet.balance, existingTxEntity);

      const pendingEvent = WagerTransactionPendingReference.from(tx, eventCtx);
      em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(pendingEvent)));

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    const ref = WagerTransactionMapper.toDomain(refEntity);

    // Validate reference rules
    const validationError = this.validateReversalReference(dto, wallet, ref, money, [
      WagerTransactionKind.Bet,
    ]);
    if (validationError) {
      tx.reject(validationError);
      this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
      em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventCtx))));
      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
        failureCode: tx.failureCode,
      };
    }

    // Check if already refunded
    const alreadyRefunded = await em.findOne(WagerTransactionEntity, {
      referenceTransactionId: ref.id,
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.Processed,
    });
    if (alreadyRefunded) {
      tx.reject(FailureCode.REFERENCE_ALREADY_REVERSED);
      this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
      em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventCtx))));
      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
        failureCode: tx.failureCode,
      };
    }

    // Execute refund: credit wallet
    const ledgerId = randomUUID();
    const ledgerEntry = wallet.credit(money, tx.id, ledgerId);
    tx.markProcessed(ref.id);

    WalletMapper.updateEntity(wallet, walletEntity);
    this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
    em.persist(walletEntity);
    await em.flush?.();

    em.persist(WalletLedgerMapper.toEntity(ledgerEntry));

    em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, eventCtx))));
    em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, eventCtx))));

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async handleRollback(
    em: EntityManager,
    wallet: Wallet,
    tx: WagerTransaction,
    money: Money,
    dto: ProcessWagerDto,
    eventCtx: { correlationId: string; causationId?: string },
    walletEntity: WalletEntity,
    existingTxEntity?: WagerTransactionEntity,
  ): Promise<WagerResultDto> {
    const refEntity = await em.findOne(WagerTransactionEntity, {
      providerId: dto.providerId,
      externalTransactionId: dto.referenceExternalTransactionId,
    });

    if (!refEntity) {
      tx.markPendingReference();
      this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
      em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, eventCtx))));
      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    const ref = WagerTransactionMapper.toDomain(refEntity);

    const validationError = this.validateReversalReference(dto, wallet, ref, money, [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ]);
    if (validationError) {
      tx.reject(validationError);
      this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
      em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventCtx))));
      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
        failureCode: tx.failureCode,
      };
    }

    // Check if already rolled back
    const alreadyRolledBack = await em.findOne(WagerTransactionEntity, {
      referenceTransactionId: ref.id,
      kind: WagerTransactionKind.Rollback,
      status: WagerTransactionStatus.Processed,
    });
    if (alreadyRolledBack) {
      tx.reject(FailureCode.REFERENCE_ALREADY_REVERSED);
      this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
      em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventCtx))));
      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
        failureCode: tx.failureCode,
      };
    }

    // Determine direction: inverts the referenced direction
    const ledgerId = randomUUID();
    let ledgerEntry;

    if (ref.kind === WagerTransactionKind.Bet) {
      // Reversing a BET (Debit) -> Credit
      ledgerEntry = wallet.credit(money, tx.id, ledgerId);
    } else {
      // Reversing a WIN or REFUND (Credit) -> Debit
      if (wallet.balance.isLessThan(money)) {
        tx.reject(FailureCode.ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE);
        this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
        em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventCtx))));
        return {
          transactionId: tx.id,
          status: tx.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
          failureCode: tx.failureCode,
        };
      }
      ledgerEntry = wallet.debit(money, tx.id, ledgerId);
    }

    tx.markProcessed(ref.id);

    WalletMapper.updateEntity(wallet, walletEntity);
    this.persistTransaction(em, tx, wallet.balance, existingTxEntity);
    em.persist(walletEntity);
    await em.flush?.();

    em.persist(WalletLedgerMapper.toEntity(ledgerEntry));

    em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, eventCtx))));
    em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, eventCtx))));

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private validateReversalReference(
    dto: ProcessWagerDto,
    wallet: Wallet,
    ref: WagerTransaction,
    money: Money,
    allowedKinds: WagerTransactionKind[],
  ): FailureCode | null {
    if (ref.providerId !== dto.providerId) return FailureCode.PLAYER_MISMATCH;
    if (ref.playerId !== dto.playerId) return FailureCode.PLAYER_MISMATCH;
    if (ref.walletId !== dto.walletId) return FailureCode.WALLET_MISMATCH;
    if (ref.roundId !== dto.roundId) return FailureCode.ROUND_MISMATCH;
    if (ref.money.currency !== wallet.currency) return FailureCode.CURRENCY_MISMATCH;
    if (!allowedKinds.includes(ref.kind)) return FailureCode.INVALID_REFERENCE_KIND;
    if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.INVALID_REFERENCE_STATUS;
    if (!ref.money.equals(money)) return FailureCode.AMOUNT_MISMATCH;
    return null;
  }

  private validateWinReference(
    dto: ProcessWagerDto,
    wallet: Wallet,
    ref: WagerTransaction,
  ): FailureCode | null {
    if (ref.providerId !== dto.providerId) return FailureCode.PLAYER_MISMATCH;
    if (ref.playerId !== dto.playerId) return FailureCode.PLAYER_MISMATCH;
    if (ref.walletId !== dto.walletId) return FailureCode.WALLET_MISMATCH;
    if (ref.roundId !== dto.roundId) return FailureCode.ROUND_MISMATCH;
    if (ref.money.currency !== wallet.currency) return FailureCode.CURRENCY_MISMATCH;
    if (ref.kind !== WagerTransactionKind.Bet) return FailureCode.INVALID_REFERENCE_KIND;
    if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.INVALID_REFERENCE_STATUS;
    return null;
  }

  private async rejectImmediately(
    em: EntityManager,
    dto: ProcessWagerDto,
    idempotencyKey: string,
    payloadHash: string,
    wallet: Wallet,
    code: FailureCode,
    eventCtx: { correlationId: string; causationId?: string },
  ): Promise<WagerResultDto> {
    const tx = WagerTransaction.create({
      id: randomUUID(),
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: Money.from(dto.money),
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    });
    tx.reject(code);

    this.persistTransaction(em, tx, wallet.balance);
    em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventCtx))));

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
      failureCode: code,
    };
  }
}
