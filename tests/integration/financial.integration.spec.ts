import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionService } from '../../src/application/services/wager-transaction.service';
import { WalletService } from '../../src/application/services/wallet.service';
import { IdempotencyService } from '../../src/application/services/idempotency.service';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { InboxEntity } from '../../src/infrastructure/database/entities/inbox.entity';
import { WalletEntity } from '../../src/infrastructure/database/entities/wallet.entity';
import { WalletLedgerEntity } from '../../src/infrastructure/database/entities/wallet-ledger.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { SqsConsumer } from '../../src/infrastructure/messaging/sqs.consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox.publisher';
import { SqsService } from '../../src/infrastructure/messaging/sqs.client';
import { MetricsService } from '../../src/observability/metrics.service';
import databaseConfig from '../../src/infrastructure/database/mikro-orm.config';

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === '1';
const describeIntegration = describe.skipIf(!integrationEnabled);

describeIntegration('PostgreSQL and LocalStack integration', () => {
  let orm: MikroORM;
  let sqs: SqsService;

  const metrics = () => new MetricsService();
  const wagerService = () =>
    new WagerTransactionService(orm.em.fork(), new IdempotencyService(), metrics());
  const walletService = () => new WalletService(orm.em.fork(), metrics());

  async function openWallet(initialBalance = '100.00') {
    return walletService().openWallet({
      playerId: `integration-${randomUUID()}`,
      initialBalance: { amount: initialBalance, currency: 'BRL' },
    });
  }

  async function receiveOne(queueUrl: string, expectedMessageId: string) {
    for (let batchNumber = 0; batchNumber < 50; batchNumber += 1) {
      const messages = await sqs.receiveMessages(queueUrl, 10, 1);
      for (const message of messages) {
        let actualMessageId: string | undefined;
        try {
          actualMessageId = JSON.parse(message.Body || '{}').messageId;
        } catch {
          // Drop stale malformed test messages while looking for the requested message.
        }
        if (actualMessageId === expectedMessageId) return message;
        if (message.ReceiptHandle) {
          await sqs.deleteMessage(queueUrl, message.ReceiptHandle);
        }
      }
    }
    throw new Error(`Message ${expectedMessageId} was not received from ${queueUrl}`);
  }

  async function runInSeparateProcess(request: {
    dto: Parameters<WagerTransactionService['processTransaction']>[0];
    idempotencyKey: string;
    count: number;
  }) {
    const child = Bun.spawn(
      ['bun', 'run', 'scripts/integration-wager-worker.ts', JSON.stringify(request)],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } as Record<string, string> },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`Integration worker failed (${exitCode}): ${stderr}\n${stdout}`);
    }
    const jsonLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!jsonLine) throw new Error(`Integration worker returned no result: ${stdout}`);
    return JSON.parse(jsonLine) as Array<{ idempotentReplay: boolean; status: string }>;
  }

  beforeAll(async () => {
    orm = await MikroORM.init({
      ...databaseConfig,
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5433),
      user: process.env.DB_USER || 'wagering_test_user',
      password: process.env.DB_PASSWORD || 'wagering_test_pass',
      dbName: process.env.DB_NAME || 'wagering_test_db',
    });
    await orm.migrator.up();
    sqs = new SqsService();
    await sqs.ensureQueues();
    await sqs.checkReady();
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  it('serializes concurrent wallet debits and same-key redeliveries across separate EntityManagers', async () => {
    const wallet = await openWallet();
    const services = [wagerService(), wagerService(), wagerService()];
    const twoBets = await Promise.all([
      services[0].processTransaction({
        providerId: 'integration-provider', externalTransactionId: `bet-a-${randomUUID()}`,
        playerId: wallet.playerId, walletId: wallet.id, roundId: 'race', gameId: 'integration',
        kind: WagerTransactionKind.Bet, money: { amount: '80.00', currency: 'BRL' },
      }),
      services[1].processTransaction({
        providerId: 'integration-provider', externalTransactionId: `bet-b-${randomUUID()}`,
        playerId: wallet.playerId, walletId: wallet.id, roundId: 'race', gameId: 'integration',
        kind: WagerTransactionKind.Bet, money: { amount: '80.00', currency: 'BRL' },
      }),
    ]);

    expect(twoBets.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(twoBets.filter((result) => result.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);

    const duplicateWallet = await openWallet();
    const duplicateDto = {
      providerId: 'integration-provider', externalTransactionId: `same-${randomUUID()}`,
      playerId: duplicateWallet.playerId, walletId: duplicateWallet.id, roundId: 'parallel',
      gameId: 'integration', kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };
    const duplicateKey = `integration:${randomUUID()}`;
    const duplicatesByProcess = await Promise.all([17, 17, 16].map((count) =>
      runInSeparateProcess({ dto: duplicateDto, idempotencyKey: duplicateKey, count }),
    ));
    const duplicates = duplicatesByProcess.flat();
    expect(duplicates.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(duplicates.filter((result) => result.idempotentReplay)).toHaveLength(49);

    const checkEm = orm.em.fork();
    const storedWallet = await checkEm.findOneOrFail(WalletEntity, { id: duplicateWallet.id });
    const debits = await checkEm.find(WalletLedgerEntity, {
      walletId: duplicateWallet.id,
      direction: 'DEBIT',
    });
    expect(storedWallet.balance).toBe('90.00');
    expect(debits).toHaveLength(1);

    await expect(
      checkEm.getConnection().execute(
        'UPDATE wallet_ledger SET amount = amount WHERE id = ?',
        [debits[0].id],
      ),
    ).rejects.toThrow();
  }, { timeout: 60_000 });

  it('applies a pending refund to its existing transaction when the BET arrives later', async () => {
    const wallet = await openWallet();
    const service = wagerService();
    const referenceExternalId = `late-bet-${randomUUID()}`;
    const refund = await service.processTransaction({
      providerId: 'integration-provider', externalTransactionId: `refund-${randomUUID()}`,
      playerId: wallet.playerId, walletId: wallet.id, roundId: 'late-reference',
      gameId: 'integration', kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: referenceExternalId,
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    await service.processTransaction({
      providerId: 'integration-provider', externalTransactionId: referenceExternalId,
      playerId: wallet.playerId, walletId: wallet.id, roundId: 'late-reference',
      gameId: 'integration', kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(await service.retryPendingReference(refund.transactionId)).toBe(true);

    const checkEm = orm.em.fork();
    const refundEntity = await checkEm.findOneOrFail(WagerTransactionEntity, { id: refund.transactionId });
    const storedWallet = await checkEm.findOneOrFail(WalletEntity, { id: wallet.id });
    expect(refundEntity.status).toBe(WagerTransactionStatus.Processed);
    expect(storedWallet.balance).toBe('100.00');
  });

  it('commits SQS inbox and financial work together and publishes outbox events to the event queue', async () => {
    const wallet = await openWallet();
    const messageId = `integration-message-${randomUUID()}`;
    const externalTransactionId = `sqs-bet-${randomUUID()}`;
    const body = JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'integration-provider', externalTransactionId,
        idempotencyKey: `integration:${externalTransactionId}`,
        playerId: wallet.playerId, walletId: wallet.id, roundId: 'sqs', gameId: 'integration',
        kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' },
      },
    });
    await sqs.sendMessage(sqs.getMainQueueUrl(), body, wallet.id, messageId);
    const message = await receiveOne(sqs.getMainQueueUrl(), messageId);
    const consumer = new SqsConsumer(orm.em.fork(), sqs, wagerService(), metrics());
    expect(await consumer.processSingleMessage(message)).toBe(true);
    // Simulate redelivery after the SQL commit but before the prior ack reached SQS.
    expect(await consumer.processSingleMessage(message)).toBe(true);

    const checkEm = orm.em.fork();
    const inbox = await checkEm.findOne(InboxEntity, {
      consumerName: SqsConsumer.CONSUMER_NAME,
      messageId,
    });
    const transaction = await checkEm.findOneOrFail(WagerTransactionEntity, {
      providerId: 'integration-provider', externalTransactionId,
    });
    const storedWallet = await checkEm.findOneOrFail(WalletEntity, { id: wallet.id });
    expect(inbox?.processedAt).toBeDefined();
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(storedWallet.balance).toBe('90.00');

    const publisher = new OutboxPublisher(orm.em.fork(), sqs, metrics());
    await publisher.publishPendingMessages(500);
    let targetEventReceived = false;
    for (let batchNumber = 0; batchNumber < 25 && !targetEventReceived; batchNumber += 1) {
      // Earlier integration runs may leave opening events ahead of this event in the FIFO queue.
      const publishedEvents = await sqs.receiveMessages(sqs.getOutboxQueueUrl(), 10, 1);
      if (publishedEvents.length === 0) break;
      for (const event of publishedEvents) {
        const eventBody = JSON.parse(event.Body || '{}');
        if (
          eventBody.eventType === 'WagerTransactionProcessed' &&
          eventBody.data?.transactionId === transaction.id
        ) {
          targetEventReceived = true;
        }
        if (event.ReceiptHandle) {
          await sqs.deleteMessage(sqs.getOutboxQueueUrl(), event.ReceiptHandle);
        }
      }
    }
    expect(targetEventReceived).toBe(true);
  }, { timeout: 60_000 });

  it('rolls back wallet, ledger, transaction, outbox and inbox when the inbox commit fails', async () => {
    const wallet = await openWallet();
    const messageId = `forced-inbox-failure-${randomUUID()}`;
    const externalTransactionId = `rollback-check-${randomUUID()}`;
    const connection = orm.em.getConnection();
    await connection.execute(`
      CREATE OR REPLACE FUNCTION integration_fail_inbox_update()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.message_id = '${messageId}' THEN
          RAISE EXCEPTION 'forced inbox commit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await connection.execute(`
      CREATE TRIGGER integration_fail_inbox_update_trigger
      BEFORE UPDATE ON inbox
      FOR EACH ROW EXECUTE FUNCTION integration_fail_inbox_update()
    `);

    try {
      const body = JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'integration-provider', externalTransactionId,
          idempotencyKey: `integration:${externalTransactionId}`,
          playerId: wallet.playerId, walletId: wallet.id, roundId: 'forced-rollback',
          gameId: 'integration', kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        },
      });
      await sqs.sendMessage(sqs.getMainQueueUrl(), body, wallet.id, messageId);
      const message = await receiveOne(sqs.getMainQueueUrl(), messageId);
      const consumer = new SqsConsumer(orm.em.fork(), sqs, wagerService(), metrics());
      expect(await consumer.processSingleMessage(message)).toBe(false);

      const checkEm = orm.em.fork();
      const inbox = await checkEm.findOne(InboxEntity, {
        consumerName: SqsConsumer.CONSUMER_NAME,
        messageId,
      });
      const transaction = await checkEm.findOne(WagerTransactionEntity, {
        providerId: 'integration-provider', externalTransactionId,
      });
      const storedWallet = await checkEm.findOneOrFail(WalletEntity, { id: wallet.id });
      const ledger = await checkEm.find(WalletLedgerEntity, { walletId: wallet.id });
      const outbox = await checkEm.getConnection().execute(
        `SELECT id FROM outbox WHERE payload->'data'->>'transactionId' = ?`,
        [transaction?.id ?? 'missing'],
      );
      expect(inbox).toBeNull();
      expect(transaction).toBeNull();
      expect(storedWallet.balance).toBe('100.00');
      expect(ledger).toHaveLength(1); // Only the original OPENING credit remains.
      expect(outbox).toHaveLength(0);
    } finally {
      await connection.execute('DROP TRIGGER IF EXISTS integration_fail_inbox_update_trigger ON inbox');
      await connection.execute('DROP FUNCTION IF EXISTS integration_fail_inbox_update()');
    }
  });
});
