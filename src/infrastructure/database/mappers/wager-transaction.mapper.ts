import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction';
import { Money } from '../../../domain/common/money';
import { FailureCode } from '../../../domain/wagering/failure-code';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';

export class WagerTransactionMapper {
  public static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind,
      money: Money.from({ amount: entity.amount, currency: entity.currency }),
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      status: entity.status as WagerTransactionStatus,
      referenceTransactionId: entity.referenceTransactionId,
      failureCode: entity.failureCode as FailureCode | undefined,
      createdAt: entity.createdAt,
      processedAt: entity.processedAt,
    });
  }

  public static toEntity(
    domain: WagerTransaction,
    resultBalance?: Money,
  ): WagerTransactionEntity {
    return this.updateEntity(domain, new WagerTransactionEntity(), resultBalance);
  }

  public static updateEntity(
    domain: WagerTransaction,
    entity: WagerTransactionEntity,
    resultBalance?: Money,
  ): WagerTransactionEntity {
    entity.id = domain.id;
    entity.providerId = domain.providerId;
    entity.externalTransactionId = domain.externalTransactionId;
    entity.idempotencyKey = domain.idempotencyKey;
    entity.payloadHash = domain.payloadHash;
    entity.walletId = domain.walletId;
    entity.playerId = domain.playerId;
    entity.roundId = domain.roundId;
    entity.gameId = domain.gameId;
    entity.kind = domain.kind;
    entity.amount = domain.money.amount;
    entity.currency = domain.money.currency;
    entity.referenceExternalTransactionId = domain.referenceExternalTransactionId;
    entity.referenceTransactionId = domain.referenceTransactionId;
    entity.status = domain.status;
    entity.failureCode = domain.failureCode;
    entity.createdAt = domain.createdAt;
    entity.processedAt = domain.processedAt;
    if (resultBalance) {
      entity.resultBalanceAmount = resultBalance.amount;
      entity.resultBalanceCurrency = resultBalance.currency;
    }
    if (domain.status === WagerTransactionStatus.PendingReference) {
      entity.referenceNextAttemptAt ??= new Date(Date.now() + 1000);
    } else {
      entity.referenceNextAttemptAt = undefined;
    }
    return entity;
  }
}
