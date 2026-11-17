import { IntegrationEvent, EventContext } from '../integration-event';
import { WagerTransaction, WagerTransactionKind } from '../../wagering/wager-transaction';
import { MoneyProps } from '../../common/money';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  occurredAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  public static from(
    tx: WagerTransaction,
    ctx: EventContext,
    eventId: string = crypto.randomUUID(),
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: tx.createdAt,
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
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        occurredAt: tx.createdAt.toISOString(),
      },
    });
  }
}
