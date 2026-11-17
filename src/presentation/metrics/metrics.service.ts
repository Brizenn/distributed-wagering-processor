import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  private transactionsTotal = {
    PROCESSED: 0,
    REJECTED: 0,
    PENDING_REFERENCE: 0,
    FAILED: 0,
  };

  private duplicatesDetected = 0;
  private retriesCount = 0;
  private dlqMessagesCount = 0;
  private lockContentionCount = 0;
  private latenciesMs: number[] = [];

  public recordTransactionStatus(status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED'): void {
    if (this.transactionsTotal[status] !== undefined) {
      this.transactionsTotal[status] += 1;
    }
  }

  public recordDuplicateDetected(): void {
    this.duplicatesDetected += 1;
  }

  public recordRetry(): void {
    this.retriesCount += 1;
  }

  public recordDlqMessage(): void {
    this.dlqMessagesCount += 1;
  }

  public recordLockContention(): void {
    this.lockContentionCount += 1;
  }

  public recordLatency(durationMs: number): void {
    this.latenciesMs.push(durationMs);
    if (this.latenciesMs.length > 1000) {
      this.latenciesMs.shift();
    }
  }

  public getSnapshot(): {
    transactions: Record<string, number>;
    duplicatesDetected: number;
    retriesCount: number;
    dlqMessagesCount: number;
    lockContentionCount: number;
    latency: { p50: number; p95: number; p99: number; count: number };
  } {
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const count = sorted.length;
    const p50 = count > 0 ? sorted[Math.floor(count * 0.5)] : 0;
    const p95 = count > 0 ? sorted[Math.floor(count * 0.95)] : 0;
    const p99 = count > 0 ? sorted[Math.floor(count * 0.99)] : 0;

    return {
      transactions: { ...this.transactionsTotal },
      duplicatesDetected: this.duplicatesDetected,
      retriesCount: this.retriesCount,
      dlqMessagesCount: this.dlqMessagesCount,
      lockContentionCount: this.lockContentionCount,
      latency: { p50, p95, p99, count },
    };
  }
}
