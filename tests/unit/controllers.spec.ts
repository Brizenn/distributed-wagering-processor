import { describe, expect, it } from 'bun:test';
import { WalletsController } from '../../src/presentation/controllers/wallets.controller';
import { WageringController } from '../../src/presentation/controllers/wagering.controller';
import { HealthController } from '../../src/presentation/controllers/health.controller';
import { MetricsService } from '../../src/presentation/metrics/metrics.service';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';

describe('Presentation Controllers (Unit)', () => {
  it('should handle WalletsController endpoints', async () => {
    const mockWalletService: any = {
      openWallet: async (dto: any) => ({
        id: 'w-1',
        playerId: dto.playerId,
        balance: dto.initialBalance,
        version: 1,
      }),
      getWallet: async (id: string) => ({
        id,
        playerId: 'p-1',
        currency: 'BRL',
        balance: { amount: '100.00', currency: 'BRL' },
        version: 1,
      }),
      getLedger: async (id: string, cursor?: string, limit?: number) => ({
        entries: [],
        nextCursor: undefined,
      }),
      reconcileWallet: async (id: string) => ({
        walletId: id,
        storedBalance: { amount: '100.00', currency: 'BRL' },
        calculatedBalance: { amount: '100.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 5,
      }),
    };

    const controller = new WalletsController(mockWalletService);

    const created = await controller.createWallet({
      playerId: 'p-1',
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(created.id).toBe('w-1');
    expect(created.playerId).toBe('p-1');

    const wallet = await controller.getWallet('w-1');
    expect(wallet.id).toBe('w-1');

    const ledger = await controller.getLedger('w-1', undefined, '10');
    expect(ledger.entries).toEqual([]);

    const reconciliation = await controller.reconcile('w-1');
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.checkedEntries).toBe(5);
  });

  it('should handle WageringController status mapping for PROCESSED, PENDING_REFERENCE, REJECTED', async () => {
    let mockResult: any;
    const mockWagerService: any = {
      processTransaction: async () => mockResult,
    };
    const metricsService = new MetricsService();
    const mockEm: any = {};

    const controller = new WageringController(mockWagerService, metricsService, mockEm);

    // Test PROCESSED -> 200 OK
    mockResult = {
      transactionId: 'tx-1',
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    };
    let responseStatus: number = 0;
    let responseBody: any;
    const mockRes: any = {
      status: (code: number) => {
        responseStatus = code;
        return {
          json: (body: any) => {
            responseBody = body;
          },
        };
      },
    };

    await controller.submitTransaction(
      {
        providerId: 'prv-1',
        externalTransactionId: 'ext-1',
        playerId: 'p-1',
        walletId: 'w-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      },
      'key-1',
      'corr-1',
      mockRes,
    );
    expect(responseStatus).toBe(200);
    expect(responseBody.status).toBe(WagerTransactionStatus.Processed);

    // Test PENDING_REFERENCE -> 202 Accepted
    mockResult = {
      transactionId: 'tx-2',
      status: WagerTransactionStatus.PendingReference,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    };
    await controller.submitTransaction({} as any, 'key-2', undefined, mockRes);
    expect(responseStatus).toBe(202);

    // Test REJECTED -> 422 Unprocessable Entity
    mockResult = {
      transactionId: 'tx-3',
      status: WagerTransactionStatus.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    };
    await controller.submitTransaction({} as any, 'key-3', undefined, mockRes);
    expect(responseStatus).toBe(422);
  });

  it('should return health liveness and metrics snapshot', () => {
    const metricsService = new MetricsService();
    metricsService.recordTransactionStatus('PROCESSED');
    metricsService.recordDuplicateDetected();

    const mockEm: any = {};
    const healthController = new HealthController(mockEm, metricsService);

    const live = healthController.getLive();
    expect(live.status).toBe('UP');
    expect(live.uptime).toBeGreaterThanOrEqual(0);

    const metrics: any = healthController.getMetrics();
    expect(metrics.transactions.PROCESSED).toBe(1);
    expect(metrics.duplicatesDetected).toBe(1);
  });
});
