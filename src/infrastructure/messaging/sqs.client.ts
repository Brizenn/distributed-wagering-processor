import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
export class SqsService implements OnModuleInit {
  private readonly logger = new Logger(SqsService.name);
  private readonly client: SQSClient;
  private readonly mainQueueUrl: string;
  private readonly dlqUrl: string;

  constructor() {
    const region = process.env.AWS_REGION || 'us-east-1';
    const endpoint = process.env.AWS_ENDPOINT || 'http://localhost:4566';

    this.mainQueueUrl =
      process.env.SQS_MAIN_QUEUE_URL ||
      'http://localhost:4566/000000000000/wager-transactions.fifo';
    this.dlqUrl =
      process.env.SQS_DLQ_URL ||
      'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

    this.client = new SQSClient({
      region,
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
      },
    });
  }

  public async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    await this.ensureQueues();
  }

  public async ensureQueues(): Promise<void> {
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

      this.logger.log('SQS FIFO queues verified and ready.');
    } catch (err: any) {
      this.logger.warn(`Could not auto-create SQS queues: ${err.message}`);
    }
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
}
