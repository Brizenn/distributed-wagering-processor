import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ApplicationModule } from '../../application/application.module';
import { MetricsModule } from '../../observability/metrics.module';
import { SqsClientModule } from './sqs-client.module';
import { OutboxPublisher } from './outbox.publisher';
import { SqsConsumer } from './sqs.consumer';
import { PendingReferenceWorker } from './pending-reference.worker';

@Module({
  imports: [DatabaseModule, ApplicationModule, MetricsModule, SqsClientModule],
  providers: [
    OutboxPublisher,
    SqsConsumer,
    PendingReferenceWorker,
  ],
  exports: [
    OutboxPublisher,
    SqsConsumer,
    PendingReferenceWorker,
  ],
})
export class MessagingModule {}
