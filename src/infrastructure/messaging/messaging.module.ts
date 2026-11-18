import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ApplicationModule } from '../../application/application.module';
import { PresentationModule } from '../../presentation/presentation.module';
import { SqsService } from './sqs.client';
import { OutboxPublisher } from './outbox.publisher';
import { SqsConsumer } from './sqs.consumer';
import { PendingReferenceWorker } from './pending-reference.worker';

@Module({
  imports: [DatabaseModule, ApplicationModule, PresentationModule],
  providers: [
    SqsService,
    OutboxPublisher,
    SqsConsumer,
    PendingReferenceWorker,
  ],
  exports: [
    SqsService,
    OutboxPublisher,
    SqsConsumer,
    PendingReferenceWorker,
  ],
})
export class MessagingModule {}
