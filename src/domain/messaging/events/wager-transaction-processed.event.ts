import { IntegrationEvent, EventContext } from '../integration-event';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../wagering/wager-transaction';
import { MoneyProps } from '../../common/money';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  public static from(
    tx: WagerTransaction,
    ctx: EventContext,
    eventId: string = crypto.randomUUID(),
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
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
        status: tx.status,
        money: tx.money.toJSON(),
        referenceTransactionId: tx.referenceTransactionId,
        processedAt: (tx.processedAt ?? new Date()).toISOString(),
      },
    });
  }
}
