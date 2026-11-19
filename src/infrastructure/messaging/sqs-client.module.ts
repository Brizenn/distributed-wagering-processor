import { Module } from '@nestjs/common';
import { SqsService } from './sqs.client';

@Module({ providers: [SqsService], exports: [SqsService] })
export class SqsClientModule {}
