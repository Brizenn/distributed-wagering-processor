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
  private outboxLagMs = 0;
  private reconciliationDivergences = 0;
  private latenciesMs: number[] = [];

  public recordTransactionStatus(status: string): void {
    if (status in this.transactionsTotal) {
      this.transactionsTotal[status as keyof typeof this.transactionsTotal] += 1;
    }
  }
  public recordDuplicateDetected(): void { this.duplicatesDetected += 1; }
  public recordRetry(): void { this.retriesCount += 1; }
  public setDlqMessageCount(count: number): void { this.dlqMessagesCount = Math.max(0, count); }
  public recordLockContention(): void { this.lockContentionCount += 1; }
  public recordOutboxLag(durationMs: number): void {
    this.outboxLagMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  }
  public recordReconciliationDivergence(): void { this.reconciliationDivergences += 1; }

  public recordLatency(durationMs: number): void {
    this.latenciesMs.push(durationMs);
    if (this.latenciesMs.length > 1000) this.latenciesMs.shift();
  }

  public getSnapshot(): {
    transactions: Record<string, number>;
    duplicatesDetected: number;
    retriesCount: number;
    dlqMessagesCount: number;
    lockContentionCount: number;
    outboxLagMs: number;
    reconciliationDivergences: number;
    latency: { p50: number; p95: number; p99: number; count: number };
  } {
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const count = sorted.length;
    const percentile = (fraction: number) =>
      count > 0 ? sorted[Math.min(count - 1, Math.floor(count * fraction))] : 0;
    return {
      transactions: { ...this.transactionsTotal },
      duplicatesDetected: this.duplicatesDetected,
      retriesCount: this.retriesCount,
      dlqMessagesCount: this.dlqMessagesCount,
      lockContentionCount: this.lockContentionCount,
      outboxLagMs: this.outboxLagMs,
      reconciliationDivergences: this.reconciliationDivergences,
      latency: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), count },
    };
  }
}
