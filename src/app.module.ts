import { Module } from '@nestjs/common';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ApplicationModule } from './application/application.module';
import { PresentationModule } from './presentation/presentation.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';

@Module({
  imports: [DatabaseModule, ApplicationModule, PresentationModule, MessagingModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
