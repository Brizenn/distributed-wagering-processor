import { describe, expect, it, beforeEach } from 'bun:test';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox.publisher';
import { SqsConsumer } from '../../src/infrastructure/messaging/sqs.consumer';
import { PendingReferenceWorker } from '../../src/infrastructure/messaging/pending-reference.worker';
import { OutboxEntity } from '../../src/infrastructure/database/entities/outbox.entity';
import { InboxEntity } from '../../src/infrastructure/database/entities/inbox.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { MetricsService } from '../../src/presentation/metrics/metrics.service';

describe('Messaging Layer (Unit)', () => {
  let mockSqsService: any;
  let sentMessages: any[];
  let deletedMessages: any[];

  beforeEach(() => {
    sentMessages = [];
    deletedMessages = [];
    mockSqsService = {
      getMainQueueUrl: () => 'http://localhost:4566/main.fifo',
      getDlqUrl: () => 'http://localhost:4566/dlq.fifo',
      sendMessage: async (url: string, body: string, groupId: string, dedupId: string) => {
        sentMessages.push({ url, body, groupId, dedupId });
        return 'sqs-msg-1';
      },
      deleteMessage: async (url: string, handle: string) => {
        deletedMessages.push({ url, handle });
      },
    };
  });

  describe('OutboxPublisher', () => {
    it('should query pending messages, dispatch to SQS, and mark published', async () => {
      const outboxEntity = new OutboxEntity();
      outboxEntity.id = 'evt-1';
      outboxEntity.aggregateId = 'w-1';
      outboxEntity.eventType = 'WalletBalanceChanged';
      outboxEntity.payload = { test: true };
      outboxEntity.occurredAt = new Date();
      outboxEntity.attempts = 0;

      const mockEm: any = {
        fork: () => mockEm,
        transactional: async (cb: any) => cb(mockEm),
        getConnection: () => ({
          execute: async () => [{ id: 'evt-1' }],
        }),
        find: async () => [outboxEntity],
        flush: async () => {},
      };

      const publisher = new OutboxPublisher(mockEm, mockSqsService);
      const count = await publisher.publishPendingMessages();

      expect(count).toBe(1);
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].groupId).toBe('w-1');
      expect(sentMessages[0].dedupId).toBe('evt-1');
      expect(outboxEntity.publishedAt).toBeDefined();
    });

    it('should schedule retry with exponential backoff on dispatch failure', async () => {
      const outboxEntity = new OutboxEntity();
      outboxEntity.id = 'evt-fail';
      outboxEntity.aggregateId = 'w-1';
      outboxEntity.eventType = 'WalletBalanceChanged';
      outboxEntity.payload = { test: true };
      outboxEntity.occurredAt = new Date();
      outboxEntity.attempts = 0;

      const failingSqs = {
        ...mockSqsService,
        sendMessage: async () => {
          throw new Error('SQS Network Down');
        },
      };

      const mockEm: any = {
        fork: () => mockEm,
        transactional: async (cb: any) => cb(mockEm),
        getConnection: () => ({
          execute: async () => [{ id: 'evt-fail' }],
        }),
        find: async () => [outboxEntity],
        flush: async () => {},
      };

      const publisher = new OutboxPublisher(mockEm, failingSqs);
      const count = await publisher.publishPendingMessages();

      expect(count).toBe(0);
      expect(outboxEntity.publishedAt).toBeUndefined();
      expect(outboxEntity.attempts).toBe(1);
      expect(outboxEntity.nextAttemptAt).toBeDefined();
    });
  });

  describe('SqsConsumer', () => {
    it('should deduplicate messages using persistent inbox and process once', async () => {
      let inboxRecords: Map<string, InboxEntity> = new Map();
      let processedWagers: any[] = [];

      const mockEm: any = {
        fork: () => mockEm,
        transactional: async (cb: any) => cb(mockEm),
        findOne: async (cls: any, filter: any) => {
          return inboxRecords.get(filter.messageId) ?? null;
        },
        persist: (e: any) => {
          if (e instanceof InboxEntity) {
            inboxRecords.set(e.messageId, e);
          }
        },
      };

      const mockWagerService: any = {
        processTransaction: async (dto: any) => {
          processedWagers.push(dto);
          return { status: WagerTransactionStatus.Processed };
        },
      };

      const metricsService = new MetricsService();
      const consumer = new SqsConsumer(mockEm, mockSqsService, mockWagerService, metricsService);

      const validMsg = {
        MessageId: 'sqs-100',
        ReceiptHandle: 'handle-100',
        Body: JSON.stringify({
          messageId: 'msg-unique-1',
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'prv-1',
            externalTransactionId: 'ext-1',
            playerId: 'p-1',
            walletId: 'w-1',
            roundId: 'r-1',
            gameId: 'g-1',
            kind: WagerTransactionKind.Bet,
            money: { amount: '10.00', currency: 'BRL' },
          },
        }),
      };

      // 1st delivery
      const res1 = await consumer.processSingleMessage(validMsg);
      expect(res1).toBe(true);
      expect(processedWagers.length).toBe(1);
      expect(deletedMessages.length).toBe(1);

      // 2nd delivery (Redelivery / Duplicate)
      const res2 = await consumer.processSingleMessage(validMsg);
      expect(res2).toBe(true);
      // Business logic must NOT be called a second time
      expect(processedWagers.length).toBe(1);
      // But message was acked to clear from SQS
      expect(deletedMessages.length).toBe(2);
    });
  });

  describe('PendingReferenceWorker', () => {
    it('should reprocess pending transaction when reference transaction becomes available', async () => {
      const pendingTx = new WagerTransactionEntity();
      pendingTx.id = 'tx-refund-pending';
      pendingTx.providerId = 'prv-1';
      pendingTx.externalTransactionId = 'ext-refund';
      pendingTx.referenceExternalTransactionId = 'ext-bet';
      pendingTx.walletId = 'w-1';
      pendingTx.playerId = 'p-1';
      pendingTx.roundId = 'r-1';
      pendingTx.gameId = 'g-1';
      pendingTx.kind = WagerTransactionKind.Refund;
      pendingTx.amount = '20.00';
      pendingTx.currency = 'BRL';
      pendingTx.status = WagerTransactionStatus.PendingReference;
      pendingTx.createdAt = new Date();

      const processedBet = new WagerTransactionEntity();
      processedBet.id = 'tx-bet-original';
      processedBet.providerId = 'prv-1';
      processedBet.externalTransactionId = 'ext-bet';
      processedBet.status = WagerTransactionStatus.Processed;

      let reprocessedCalls: any[] = [];
      const mockWagerService: any = {
        processTransaction: async (dto: any) => {
          reprocessedCalls.push(dto);
          return { status: WagerTransactionStatus.Processed };
        },
      };

      const mockEm: any = {
        fork: () => mockEm,
        transactional: async (cb: any) => cb(mockEm),
        find: async () => [pendingTx],
        findOne: async (_cls: any, filter: any) => {
          if (filter.externalTransactionId === 'ext-bet') {
            return processedBet;
          }
          return null;
        },
        removeAndFlush: async () => {},
        flush: async () => {},
      };

      const worker = new PendingReferenceWorker(mockEm, mockWagerService);
      const handled = await worker.reprocessPendingReferences();

      expect(handled).toBe(1);
      expect(reprocessedCalls.length).toBe(1);
      expect(reprocessedCalls[0].externalTransactionId).toBe('ext-refund');
    });
  });
});
