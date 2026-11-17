import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ApplicationModule } from '../application/application.module';
import { DatabaseModule } from '../infrastructure/database/database.module';
import { WalletsController } from './controllers/wallets.controller';
import { WageringController } from './controllers/wagering.controller';
import { HealthController } from './controllers/health.controller';
import { MetricsService } from './metrics/metrics.service';
import { ProviderAuthGuard } from './auth/auth.guard';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

@Module({
  imports: [ApplicationModule, DatabaseModule],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    MetricsService,
    {
      provide: APP_GUARD,
      useClass: ProviderAuthGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
  exports: [MetricsService],
})
export class PresentationModule {}
