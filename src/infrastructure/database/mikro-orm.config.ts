import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletLedgerEntity } from './entities/wallet-ledger.entity';
import { InboxEntity } from './entities/inbox.entity';
import { OutboxEntity } from './entities/outbox.entity';
import { Migration20261117000001_InitialSchema } from './migrations/Migration20261117000001_InitialSchema';
import { Migration20261118000002_StrengthenFinancialInvariants } from './migrations/Migration20261118000002_StrengthenFinancialInvariants';

export default defineConfig({
  driver: PostgreSqlDriver,
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'wagering_user',
  password: process.env.DB_PASSWORD || 'wagering_pass',
  dbName: process.env.DB_NAME || 'wagering_db',
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntity,
    InboxEntity,
    OutboxEntity,
  ],
  extensions: [Migrator],
  migrations: {
    tableName: 'mikro_orm_migrations',
    path: './dist/src/infrastructure/database/migrations',
    pathTs: './src/infrastructure/database/migrations',
    migrationsList: [
      {
        name: 'Migration20261117000001_InitialSchema',
        class: Migration20261117000001_InitialSchema,
      },
      {
        name: 'Migration20261118000002_StrengthenFinancialInvariants',
        class: Migration20261118000002_StrengthenFinancialInvariants,
      },
    ],
    transactional: true,
    allOrNothing: true,
  },
  debug: false,
});
