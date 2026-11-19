import { Injectable, Logger } from '@nestjs/common';
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  Message,
} from '@aws-sdk/client-sqs';

@Injectable()
export class SqsService {
  private readonly logger = new Logger(SqsService.name);
  private readonly client: SQSClient;
  private readonly mainQueueUrl: string;
  private readonly dlqUrl: string;
  private readonly outboxQueueUrl: string;
  private queuesEnsured = false;

  constructor() {
    const region = process.env.AWS_REGION || 'us-east-1';
    const endpoint = process.env.AWS_ENDPOINT || 'http://localhost:4566';
    const queueBaseUrl = `${endpoint.replace(/\/$/, '')}/000000000000`;

    this.mainQueueUrl =
      process.env.SQS_MAIN_QUEUE_URL ||
      `${queueBaseUrl}/wager-transactions.fifo`;
    this.dlqUrl =
      process.env.SQS_DLQ_URL ||
      `${queueBaseUrl}/wager-transactions-dlq.fifo`;
    this.outboxQueueUrl =
      process.env.SQS_OUTBOX_QUEUE_URL ||
      `${queueBaseUrl}/wager-events.fifo`;

    this.client = new SQSClient({
      region,
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
      },
    });
  }

  public async ensureQueues(): Promise<void> {
    if (this.queuesEnsured) return;
    try {
      // 1. Ensure DLQ exists
      await this.client.send(
        new CreateQueueCommand({
          QueueName: 'wager-transactions-dlq.fifo',
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
          },
        }),
      );

      // 2. Fetch DLQ ARN
      const dlqAttrs = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.dlqUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      const dlqArn = dlqAttrs.Attributes?.QueueArn;

      // 3. Ensure Main Queue exists with DLQ Redrive policy
      const mainAttrs: Record<string, string> = {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      };
      if (dlqArn) {
        mainAttrs.RedrivePolicy = JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: '3',
        });
      }

      await this.client.send(
        new CreateQueueCommand({
          QueueName: 'wager-transactions.fifo',
          Attributes: mainAttrs,
        }),
      );

      // Integration events have their own queue; the request consumer must never
      // acknowledge and discard events produced by the outbox.
      await this.client.send(
        new CreateQueueCommand({
          QueueName: 'wager-events.fifo',
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
          },
        }),
      );

      this.queuesEnsured = true;
      this.logger.log('SQS FIFO queues verified and ready.');
    } catch (err: any) {
      this.logger.error(`Could not auto-create SQS queues: ${err.message}`);
      throw err;
    }
  }

  public async checkReady(): Promise<void> {
    for (const queueUrl of [this.mainQueueUrl, this.outboxQueueUrl, this.dlqUrl]) {
      const response = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      if (!response.Attributes?.QueueArn) {
        throw new Error(`SQS queue is unavailable: ${queueUrl}`);
      }
    }
  }

  public async getDlqApproximateMessageCount(): Promise<number> {
    const response = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    return Number.parseInt(response.Attributes?.ApproximateNumberOfMessages ?? '0', 10) || 0;
  }

  public async sendMessage(
    queueUrl: string,
    messageBody: string,
    messageGroupId: string,
    messageDeduplicationId?: string,
  ): Promise<string | undefined> {
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: messageBody,
      MessageGroupId: messageGroupId,
      MessageDeduplicationId: messageDeduplicationId,
    });

    const response = await this.client.send(command);
    return response.MessageId;
  }

  public async receiveMessages(
    queueUrl: string,
    maxMessages: number = 10,
    waitTimeSeconds: number = 5,
  ): Promise<Message[]> {
    const command = new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: waitTimeSeconds,
      VisibilityTimeout: 30,
    });

    const response = await this.client.send(command);
    return response.Messages ?? [];
  }

  public async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    const command = new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    });
    await this.client.send(command);
  }

  public async changeVisibility(
    queueUrl: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    const command = new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: visibilityTimeoutSeconds,
    });
    await this.client.send(command);
  }

  public getMainQueueUrl(): string {
    return this.mainQueueUrl;
  }

  public getDlqUrl(): string {
    return this.dlqUrl;
  }

  public getOutboxQueueUrl(): string {
    return this.outboxQueueUrl;
  }
}
