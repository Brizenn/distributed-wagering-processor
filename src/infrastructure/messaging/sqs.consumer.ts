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

export interface SqsEnvelope<T> {
  messageId: string;
  type: string;
  occurredAt: string;
  data: T;
}

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
      await this.sqsService.ensureQueues();
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

    let envelope: SqsEnvelope<ProcessWagerDto>;
    try {
      envelope = JSON.parse(msg.Body);
    } catch {
      this.logger.error(`Malformed JSON in SQS message ${msg.MessageId}. Letting SQS DLQ handle it.`);
      this.metricsService.recordDlqMessage();
      return false;
    }

    if (envelope.type !== 'WagerTransactionRequested' || !envelope.data) {
      // Ignored or unrecognized event type: ack to avoid poison queue
      await this.sqsService.deleteMessage(queueUrl, msg.ReceiptHandle);
      return true;
    }

    const messageId = envelope.messageId || msg.MessageId;
    const payloadHash = createHash('sha256').update(msg.Body).digest('hex');

    const forkEm = this.em.fork();

    try {
      await forkEm.transactional(async (em) => {
        // 1. Persistent Inbox deduplication check
        const existingInbox = await em.findOne(InboxEntity, {
          consumerName: SqsConsumer.CONSUMER_NAME,
          messageId,
        });

        if (existingInbox && existingInbox.processedAt) {
          this.logger.log(`Duplicate message ${messageId} detected in inbox. Replay acked.`);
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
          inboxDomain = InboxMapper.toDomain(existingInbox);
        }

        // 2. Execute business use-case (same as HTTP)
        const dto = envelope.data;
        const result = await this.wagerService.processTransaction(dto, {
          idempotencyKey: (dto as any).idempotencyKey,
          correlationId: messageId,
        });

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
      return true;
    } catch (err: any) {
      this.logger.error(
        `Transient processing failure for SQS message ${messageId}: ${err.message}. Letting SQS retry.`,
      );
      this.metricsService.recordRetry();
      // Do NOT delete message; allow AWS SQS redrive policy to retry up to maxReceiveCount
      return false;
    }
  }
}
