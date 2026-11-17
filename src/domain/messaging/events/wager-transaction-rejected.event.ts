import { IntegrationEvent, EventContext } from '../integration-event';
import { WagerTransaction, WagerTransactionKind } from '../../wagering/wager-transaction';
import { FailureCode } from '../../wagering/failure-code';
import { MoneyProps } from '../../common/money';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  public static from(
    tx: WagerTransaction,
    ctx: EventContext,
    eventId: string = crypto.randomUUID(),
  ): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: tx.processedAt ?? new Date(),
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode ?? FailureCode.INTERNAL_ERROR,
        rejectedAt: (tx.processedAt ?? new Date()).toISOString(),
      },
    });
  }
}
