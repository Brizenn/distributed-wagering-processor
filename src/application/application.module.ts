import { Module } from '@nestjs/common';
import { DatabaseModule } from '../infrastructure/database/database.module';
import { IdempotencyService } from './services/idempotency.service';
import { WalletService } from './services/wallet.service';
import { WagerTransactionService } from './services/wager-transaction.service';
import { MetricsModule } from '../observability/metrics.module';

@Module({
  imports: [DatabaseModule, MetricsModule],
  providers: [IdempotencyService, WalletService, WagerTransactionService],
  exports: [IdempotencyService, WalletService, WagerTransactionService],
})
export class ApplicationModule {}
