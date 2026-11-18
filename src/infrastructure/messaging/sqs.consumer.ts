import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash } from 'crypto';
import { SqsService } from './sqs.client';
import { WagerTransactionService } from '../../application/services/wager-transaction.service';
import { MetricsService } from '../../presentation/metrics/metrics.service';
import { InboxEntity } from '../database/entities/inbox.entity';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { InboxMapper } from '../database/mappers/inbox.mapper';
import { ProcessWagerDto } from '../../application/dto/process-wager.dto';
import { ConflictError } from '../../application/errors/application-error';
import { FailureCode } from '../../domain/wagering/failure-code';

export interface SqsEnvelope<T> {
  messageId: string;
  type: string;
  occurredAt: string;
  data: T;
}

type QueueWagerData = ProcessWagerDto & { idempotencyKey: string };

@Injectable()
export class SqsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumer.name);
  public static readonly CONSUMER_NAME = 'sqs-wager-consumer';

  private isRunning = false;
  private isShuttingDown = false;
  private activeProcessingCount = 0;

  constructor(
    private readonly em: EntityManager,
    private readonly sqsService: SqsService,
    private readonly wagerService: WagerTransactionService,
    private readonly metricsService: MetricsService,
  ) {}

  public async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      this.startConsuming();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.logger.log('Gracefully stopping SQS consumer...');
    this.isShuttingDown = true;
    this.isRunning = false;

    // Wait for in-flight messages to complete processing (graceful shutdown)
    const timeout = Date.now() + 10000;
    while (this.activeProcessingCount > 0 && Date.now() < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.logger.log('SQS consumer stopped cleanly.');
  }

  public startConsuming(): void {
    this.isRunning = true;
    const loop = async () => {
      while (this.isRunning && !this.isShuttingDown) {
        try {
          await this.sqsService.ensureQueues();
          await this.pollMessages();
        } catch (err: any) {
          this.logger.error(`Error polling SQS messages: ${err.message}`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    };
    loop();
  }

  public stopConsuming(): void {
    this.isRunning = false;
  }

  public async pollMessages(): Promise<void> {
    const queueUrl = this.sqsService.getMainQueueUrl();
    const messages = await this.sqsService.receiveMessages(queueUrl, 10, 5);

    if (messages.length === 0) {
      return;
    }

    for (const msg of messages) {
      if (this.isShuttingDown) {
        // Return visibility to SQS immediately so message is not blocked
        if (msg.ReceiptHandle) {
          await this.sqsService.changeVisibility(queueUrl, msg.ReceiptHandle, 0);
        }
        continue;
      }

      this.activeProcessingCount += 1;
      try {
        await this.processSingleMessage(msg);
      } finally {
        this.activeProcessingCount -= 1;
      }
    }
  }

  public async processSingleMessage(msg: any): Promise<boolean> {
    const queueUrl = this.sqsService.getMainQueueUrl();
    if (!msg.Body || !msg.ReceiptHandle) {
      return false;
    }

    let envelope: SqsEnvelope<QueueWagerData>;
    try {
      envelope = JSON.parse(msg.Body);
    } catch {
      this.logger.error(`Malformed JSON in SQS message ${msg.MessageId}. Letting SQS DLQ handle it.`);
      return false;
    }

    if (envelope.type !== 'WagerTransactionRequested' || !envelope.data) {
      // Invalid message types are permanent poison messages and are redriven to DLQ.
      this.logger.error(`Unsupported SQS message type in ${msg.MessageId}; leaving it for redrive.`);
      return false;
    }

    const messageId = envelope.messageId || msg.MessageId;
    if (!messageId || typeof envelope.data.idempotencyKey !== 'string' || !envelope.data.idempotencyKey.trim()) {
      this.logger.error(`SQS message ${msg.MessageId} is missing messageId or idempotencyKey; leaving it for redrive.`);
      return false;
    }
    const payloadHash = createHash('sha256').update(msg.Body).digest('hex');
    const startedAt = Date.now();
    let processedResult: Awaited<ReturnType<WagerTransactionService['processTransaction']>> | undefined;

    const forkEm = this.em.fork();

    try {
      await forkEm.transactional(async (em) => {
        // 1. Persistent Inbox deduplication check
        const existingInbox = await em.findOne(InboxEntity, {
          consumerName: SqsConsumer.CONSUMER_NAME,
          messageId,
        });

        if (existingInbox && existingInbox.processedAt) {
          if (existingInbox.payloadHash !== payloadHash) {
            throw new ConflictError(
              `SQS message ${messageId} was redelivered with a different payload`,
              FailureCode.INBOX_PAYLOAD_MISMATCH,
            );
          }
          this.logger.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            event: 'SqsInboxDuplicateDetected',
            correlationId: messageId,
            messageId,
            walletId: envelope.data.walletId,
            providerId: envelope.data.providerId,
          }));
          this.metricsService.recordDuplicateDetected();
          return;
        }

        let inboxDomain: InboxMessage;
        if (!existingInbox) {
          inboxDomain = InboxMessage.receive({
            messageId,
            consumerName: SqsConsumer.CONSUMER_NAME,
            payloadHash,
          });
          em.persist(InboxMapper.toEntity(inboxDomain));
        } else {
          if (existingInbox.payloadHash !== payloadHash) {
            throw new ConflictError(
              `SQS message ${messageId} was redelivered with a different payload`,
              FailureCode.INBOX_PAYLOAD_MISMATCH,
            );
          }
          inboxDomain = InboxMapper.toDomain(existingInbox);
        }

        // 2. Execute business use-case (same as HTTP)
        const dto = envelope.data;
        const result = await this.wagerService.processTransaction(dto, {
          idempotencyKey: dto.idempotencyKey,
          correlationId: messageId,
        }, em);
        processedResult = result;
        if (result.idempotentReplay) {
          this.metricsService.recordDuplicateDetected();
        }

        inboxDomain.markProcessed();
        const updatedEntity = await em.findOne(InboxEntity, {
          consumerName: SqsConsumer.CONSUMER_NAME,
          messageId,
        });
        if (updatedEntity) {
          updatedEntity.processedAt = inboxDomain.processedAt;
        }

        this.metricsService.recordTransactionStatus(
          result.status as 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE',
        );
      });

      // 3. Ack ONLY after transaction commit!
      await this.sqsService.deleteMessage(queueUrl, msg.ReceiptHandle);
      this.metricsService.recordLatency(Date.now() - startedAt);
      this.logger.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        event: processedResult ? 'SqsWagerProcessed' : 'SqsInboxDuplicateAcknowledged',
        correlationId: messageId,
        messageId,
        transactionId: processedResult?.transactionId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
        status: processedResult?.status,
      }));
      return true;
    } catch (err: any) {
      this.metricsService.recordLatency(Date.now() - startedAt);
      this.logger.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        event: 'SqsWagerProcessingFailed',
        correlationId: messageId,
        messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
        errorName: err instanceof Error ? err.name : 'UnknownError',
        failureCode: typeof err?.failureCode === 'string' ? err.failureCode : undefined,
      }));
      this.metricsService.recordRetry();
      // Do NOT delete message; allow AWS SQS redrive policy to retry up to maxReceiveCount
      return false;
    }
  }
}
