import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/core';

@Entity({ tableName: 'wager_transactions' })
@Unique({ name: 'uq_wager_tx_provider_external', properties: ['providerId', 'externalTransactionId'] })
@Unique({ name: 'uq_wager_tx_idempotency_key', properties: ['idempotencyKey'] })
@Index({ name: 'idx_wager_tx_wallet_id', properties: ['walletId'] })
@Index({ name: 'idx_wager_tx_status', properties: ['status'] })
@Index({ name: 'idx_wager_tx_round_id', properties: ['roundId'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ type: 'string', length: 100, name: 'provider_id' })
  providerId!: string;

  @Property({ type: 'string', length: 255, name: 'external_transaction_id' })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 255, name: 'idempotency_key' })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 64, name: 'payload_hash' })
  payloadHash!: string;

  @Property({ type: 'string', name: 'wallet_id' })
  walletId!: string;

  @Property({ type: 'string', name: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', length: 255, name: 'round_id' })
  roundId!: string;

  @Property({ type: 'string', length: 255, name: 'game_id' })
  gameId!: string;

  @Property({ type: 'string', length: 50 })
  kind!: string;

  @Property({ type: 'decimal', precision: 15, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string', length: 255, nullable: true, name: 'reference_external_transaction_id' })
  referenceExternalTransactionId?: string;

  @Property({ type: 'string', nullable: true, name: 'reference_transaction_id' })
  referenceTransactionId?: string;

  @Property({ type: 'string', length: 50 })
  status!: string;

  @Property({ type: 'string', length: 100, nullable: true, name: 'failure_code' })
  failureCode?: string;

  @Property({ type: 'timestamptz', defaultRaw: 'NOW()', name: 'created_at' })
  createdAt: Date = new Date();

  @Property({ type: 'timestamptz', nullable: true, name: 'processed_at' })
  processedAt?: Date;

  @Property({ type: 'decimal', precision: 15, scale: 2, nullable: true, name: 'result_balance_amount' })
  resultBalanceAmount?: string;

  @Property({ type: 'string', length: 3, nullable: true, name: 'result_balance_currency' })
  resultBalanceCurrency?: string;

  @Property({ type: 'integer', default: 0, name: 'reference_attempts' })
  referenceAttempts: number = 0;

  @Property({ type: 'timestamptz', nullable: true, name: 'reference_next_attempt_at' })
  referenceNextAttemptAt?: Date;
}
