import { Module } from '@nestjs/common';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ApplicationModule } from './application/application.module';

@Module({
  imports: [DatabaseModule, ApplicationModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
