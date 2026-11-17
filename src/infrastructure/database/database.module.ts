import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from './mikro-orm.config';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntity } from './entities/wallet-ledger.entity';
import { InboxEntity } from './entities/inbox.entity';
import { OutboxEntity } from './entities/outbox.entity';

@Module({
  imports: [
    MikroOrmModule.forRoot(config),
    MikroOrmModule.forFeature([
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntity,
      InboxEntity,
      OutboxEntity,
    ]),
  ],
  exports: [MikroOrmModule],
})
export class DatabaseModule {}
