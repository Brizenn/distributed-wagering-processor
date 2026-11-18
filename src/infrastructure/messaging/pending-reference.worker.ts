import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionEntity } from '../database/entities/wager-transaction.entity';
import { WagerTransactionMapper } from '../database/mappers/wager-transaction.mapper';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransactionService } from '../../application/services/wager-transaction.service';
import { WagerTransactionRejected } from '../../domain/messaging/events/wager-transaction-rejected.event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { OutboxMapper } from '../database/mappers/outbox.mapper';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private static readonly TTL_MS = 5 * 60 * 1000; // 5 minutes TTL for unreferenced operations

  private isRunning = false;
  private isShuttingDown = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly em: EntityManager,
    private readonly wagerService: WagerTransactionService,
  ) {}

  public onModuleInit(): void {
    if (process.env.NODE_ENV !== 'test') {
      this.startPolling();
    }
  }

  public onModuleDestroy(): void {
    this.isShuttingDown = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  public startPolling(intervalMs: number = 3000): void {
    this.isRunning = true;
    const poll = async () => {
      if (this.isShuttingDown) return;
      try {
        await this.reprocessPendingReferences();
      } catch (err: any) {
        this.logger.error(`Error in pending reference worker cycle: ${err.message}`);
      } finally {
        if (!this.isShuttingDown && this.isRunning) {
          this.timer = setTimeout(poll, intervalMs);
        }
      }
    };
    poll();
  }

  public stopPolling(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  public async reprocessPendingReferences(): Promise<number> {
    const forkEm = this.em.fork();
    let handledCount = 0;

    await forkEm.transactional(async (em) => {
      const pendingList = await em.find(
        WagerTransactionEntity,
        { status: WagerTransactionStatus.PendingReference },
        { limit: 20 },
      );

      const now = new Date();

      for (const entity of pendingList) {
        const tx = WagerTransactionMapper.toDomain(entity);
        const refExternalId = tx.referenceExternalTransactionId;

        if (!refExternalId) {
          // Invariant violation: refund/rollback must have reference id
          tx.reject(FailureCode.REFERENCE_NOT_FOUND, now);
          entity.status = tx.status;
          entity.failureCode = tx.failureCode;
          entity.processedAt = tx.processedAt;
          handledCount += 1;
          continue;
        }

        // Check if reference transaction has now arrived and is processed
        const ref = await em.findOne(WagerTransactionEntity, {
          providerId: tx.providerId,
          externalTransactionId: refExternalId,
          status: WagerTransactionStatus.Processed,
        });

        if (ref) {
          this.logger.log(
            `Reference ${refExternalId} arrived for pending transaction ${tx.id}. Reprocessing.`,
          );
          // Delete the pending placeholder so the use case can apply with full locking and ledger
          await em.removeAndFlush(entity);

          // Re-submit through the full transactional service
          await this.wagerService.processTransaction({
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            playerId: tx.playerId,
            walletId: tx.walletId,
            roundId: tx.roundId,
            gameId: tx.gameId,
            kind: tx.kind,
            money: { amount: tx.money.amount, currency: tx.money.currency },
            referenceExternalTransactionId: tx.referenceExternalTransactionId,
          });

          handledCount += 1;
        } else {
          // Check TTL expiration
          const ageMs = now.getTime() - entity.createdAt.getTime();
          if (ageMs > PendingReferenceWorker.TTL_MS) {
            this.logger.warn(
              `Pending reference transaction ${tx.id} exceeded TTL (${ageMs}ms). Rejecting.`,
            );

            tx.reject(FailureCode.REFERENCE_NOT_FOUND, now);
            entity.status = tx.status;
            entity.failureCode = tx.failureCode;
            entity.processedAt = tx.processedAt;

            const rejectedEvent = WagerTransactionRejected.from(tx, {
              correlationId: tx.id,
            });
            em.persist(OutboxMapper.toEntity(OutboxMessage.enqueue(rejectedEvent)));
            handledCount += 1;
          }
        }
      }

      await em.flush();
    });

    return handledCount;
  }
}
