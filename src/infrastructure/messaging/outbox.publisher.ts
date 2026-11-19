import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SqsService } from './sqs.client';
import { OutboxEntity } from '../database/entities/outbox.entity';
import { OutboxMapper } from '../database/mappers/outbox.mapper';
import { MetricsService } from '../../observability/metrics.service';

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private isRunning = false;
  private isShuttingDown = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly em: EntityManager,
    private readonly sqsService: SqsService,
    private readonly metricsService: MetricsService,
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

  public startPolling(intervalMs: number = 2000): void {
    this.isRunning = true;
    const poll = async () => {
      if (this.isShuttingDown) return;
      try {
        await this.publishPendingMessages();
      } catch (err: any) {
        this.logger.error(`Error in outbox publisher cycle: ${err.message}`, err.stack);
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

  /**
   * Publishes a batch of pending messages.
   * Uses FOR UPDATE SKIP LOCKED to guarantee safe execution across multiple concurrent instances.
   */
  public async publishPendingMessages(batchSize: number = 20): Promise<number> {
    const forkEm = this.em.fork();
    let publishedCount = 0;

    await forkEm.transactional(async (em) => {
      const conn = em.getConnection();
      const lagRows = await conn.execute(
        `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))) * 1000 AS lag_ms
         FROM outbox WHERE published_at IS NULL`,
        [],
        'all',
        em.getTransactionContext?.(),
      );
      this.metricsService.recordOutboxLag(Number(lagRows?.[0]?.lag_ms ?? 0));

      // Claim due records safely with FOR UPDATE SKIP LOCKED.
      const rawRows = await conn.execute(
        `SELECT id FROM outbox
         WHERE published_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY occurred_at ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [batchSize],
        'all',
        em.getTransactionContext?.(),
      );

      if (!rawRows || rawRows.length === 0) {
        return;
      }

      const ids = rawRows.map((r: any) => r.id);
      const entities = await em.find(OutboxEntity, { id: { $in: ids } });
      for (const entity of entities) {
        const domainOutbox = OutboxMapper.toDomain(entity);
        try {
          // Send event to the dedicated SQS FIFO events queue.
          const payloadString = JSON.stringify(domainOutbox.payload);
          await this.sqsService.sendMessage(
            this.sqsService.getOutboxQueueUrl(),
            payloadString,
            domainOutbox.aggregateId, // MessageGroupId: guarantees order per wallet/aggregate
            domainOutbox.id,          // MessageDeduplicationId
          );

          domainOutbox.markPublished();
          entity.publishedAt = domainOutbox.publishedAt;
          publishedCount += 1;
        } catch (dispatchErr: any) {
          this.logger.warn(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'WARN',
            event: 'OutboxDispatchFailed',
            eventId: domainOutbox.id,
            eventType: domainOutbox.eventType,
            aggregateId: domainOutbox.aggregateId,
            errorName: dispatchErr instanceof Error ? dispatchErr.name : 'UnknownError',
          }));
          domainOutbox.scheduleRetry();
          entity.attempts = domainOutbox.attempts;
          entity.nextAttemptAt = domainOutbox.nextAttemptAt;
        }
      }

      await em.flush();
    });

    return publishedCount;
  }
}
