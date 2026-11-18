import { Injectable, Logger } from '@nestjs/common';
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
import { OutboxEntity } from '../../infrastructure/database/entities/outbox.entity';
import { WalletMapper } from '../../infrastructure/database/mappers/wallet.mapper';
import { WagerTransactionMapper } from '../../infrastructure/database/mappers/wager-transaction.mapper';
import { WalletLedgerMapper } from '../../infrastructure/database/mappers/wallet-ledger.mapper';
import { OutboxMapper } from '../../infrastructure/database/mappers/outbox.mapper';
import { WalletBalanceChanged } from '../../domain/messaging/events/wallet-balance-changed.event';
import { WagerTransactionProcessed } from '../../domain/messaging/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../domain/messaging/events/wager-transaction-rejected.event';
import { WagerTransactionPendingReference } from '../../domain/messaging/events/wager-transaction-pending-reference.event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface ProcessTransactionOptions {
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
}

@Injectable()
export class WagerTransactionService {
  private readonly logger = new Logger(WagerTransactionService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  public async processTransaction(
    dto: ProcessWagerDto,
    options: ProcessTransactionOptions = {},
  ): Promise<WagerResultDto> {
    const idempotencyKey =
      options.idempotencyKey ?? `${dto.providerId}:${dto.externalTransactionId}`;
    const payloadHash = this.idempotencyService.computePayloadHash(dto);
    const correlationId = options.correlationId ?? randomUUID();
    const causationId = options.causationId;
    const eventCtx = { correlationId, causationId };

    return await this.em.transactional(async (em) => {
      // 1. Check persistent idempotency
      const existingTxEntity = await em.findOne(WagerTransactionEntity, {
        $or: [
          { idempotencyKey },
          { providerId: dto.providerId, externalTransactionId: dto.externalTransactionId },
        ],
      });

      if (existingTxEntity) {
        const existingTx = WagerTransactionMapper.toDomain(existingTxEntity);

        if (!existingTx.matchesPayload(payloadHash)) {
          throw new ConflictError(
            `Idempotency key "${idempotencyKey}" already used with different payload`,
          );
        }

        // Idempotent replay: fetch current wallet balance
        const walletEntity = await em.findOne(WalletEntity, { id: existingTx.walletId });
        const currentBalance = walletEntity
          ? { amount: walletEntity.balance, currency: walletEntity.currency }
          : { amount: '0.00', currency: existingTx.money.currency };

        return {
          transactionId: existingTx.id,
          status: existingTx.status,
          balance: currentBalance,
          idempotentReplay: true,
          failureCode: existingTx.failureCode,
        };
      }

      // 2. Lock the wallet using PESSIMISTIC_WRITE (SELECT ... FOR UPDATE)
      // This serializes all concurrent operations for this specific wallet!
      const walletEntity = await em.findOne(
        WalletEntity,
        { id: dto.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!walletEntity) {
        throw new NotFoundError(`Wallet ${dto.walletId} not found`);
      }

      const wallet = WalletMapper.toDomain(walletEntity);
      const money = Money.from(dto.money);

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
          return await this.handleWin(em, wallet, tx, money, eventCtx, walletEntity);

        case WagerTransactionKind.Loss:
          return await this.handleLoss(em, wallet, tx, eventCtx);

        case WagerTransactionKind.Refund:
          return await this.handleRefund(em, wallet, tx, money, dto, eventCtx, walletEntity);

        case WagerTransactionKind.Rollback:
          return await this.handleRollback(em, wallet, tx, money, dto, eventCtx, walletEntity);

        default:
          throw new ConflictError(`Unsupported transaction kind: ${dto.kind}`);
      }
    });
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
      const txEntity = WagerTransactionMapper.toEntity(tx);
      em.persist(txEntity);

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
    const txEntity = WagerTransactionMapper.toEntity(tx);
    const ledgerEntity = WalletLedgerMapper.toEntity(ledgerEntry);

    em.persist(walletEntity);
    em.persist(txEntity);
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
    eventCtx: { correlationId: string; causationId?: string },
    walletEntity: WalletEntity,
  ): Promise<WagerResultDto> {
    const ledgerId = randomUUID();
    const ledgerEntry = wallet.credit(money, tx.id, ledgerId);
    tx.markProcessed();

    WalletMapper.updateEntity(wallet, walletEntity);
    const txEntity = WagerTransactionMapper.toEntity(tx);
    const ledgerEntity = WalletLedgerMapper.toEntity(ledgerEntry);

    em.persist(walletEntity);
    em.persist(txEntity);
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
    const txEntity = WagerTransactionMapper.toEntity(tx);
    em.persist(txEntity);

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
  ): Promise<WagerResultDto> {
    // Look up referenced transaction
    const refEntity = await em.findOne(WagerTransactionEntity, {
      providerId: dto.providerId,
      externalTransactionId: dto.referenceExternalTransactionId,
    });

    if (!refEntity) {
      // Reference not found yet: persist as PENDING_REFERENCE for background worker
      tx.markPendingReference();
      em.persist(WagerTransactionMapper.toEntity(tx));

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
      em.persist(WagerTransactionMapper.toEntity(tx));
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
      em.persist(WagerTransactionMapper.toEntity(tx));
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
    const txEntity = WagerTransactionMapper.toEntity(tx);
    em.persist(walletEntity);
    em.persist(txEntity);
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
  ): Promise<WagerResultDto> {
    const refEntity = await em.findOne(WagerTransactionEntity, {
      providerId: dto.providerId,
      externalTransactionId: dto.referenceExternalTransactionId,
    });

    if (!refEntity) {
      tx.markPendingReference();
      em.persist(WagerTransactionMapper.toEntity(tx));
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
      em.persist(WagerTransactionMapper.toEntity(tx));
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
      em.persist(WagerTransactionMapper.toEntity(tx));
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
        em.persist(WagerTransactionMapper.toEntity(tx));
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
    const txEntity = WagerTransactionMapper.toEntity(tx);
    em.persist(walletEntity);
    em.persist(txEntity);
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

    em.persist(WagerTransactionMapper.toEntity(tx));
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
