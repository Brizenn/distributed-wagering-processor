import { Check, Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
@Check({ name: 'chk_wallet_balance_non_negative', expression: 'balance >= 0' })
@Unique({ name: 'uq_wallet_player_currency', properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ type: 'string', name: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 15, scale: 2 })
  balance!: string;

  @Property({ type: 'integer', default: 1 })
  version: number = 1;

  @Property({ type: 'timestamptz', defaultRaw: 'NOW()', name: 'created_at' })
  createdAt: Date = new Date();

  @Property({ type: 'timestamptz', defaultRaw: 'NOW()', onUpdate: () => new Date(), name: 'updated_at' })
  updatedAt: Date = new Date();
}
