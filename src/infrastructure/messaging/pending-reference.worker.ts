import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionService } from '../../application/services/wager-transaction.service';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);

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
    const candidates = await forkEm.getConnection().execute(
      `SELECT id FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND (reference_next_attempt_at IS NULL
           OR reference_next_attempt_at <= NOW()
           OR created_at <= NOW() - INTERVAL '5 minutes')
       ORDER BY COALESCE(reference_next_attempt_at, created_at), created_at
       LIMIT ?`,
      [20],
    );

    for (const candidate of candidates ?? []) {
      try {
        if (await this.wagerService.retryPendingReference(candidate.id)) {
          handledCount += 1;
        }
      } catch (err: any) {
        this.logger.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'ERROR',
          event: 'PendingReferenceRetryFailed',
          transactionId: candidate.id,
          errorName: err instanceof Error ? err.name : 'UnknownError',
        }));
      }
    }

    return handledCount;
  }
}
