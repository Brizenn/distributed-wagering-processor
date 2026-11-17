import { Check, Entity, Index, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'wallet_ledger' })
@Check({ name: 'chk_ledger_amount_non_negative', expression: 'amount >= 0' })
@Check({ name: 'chk_ledger_balance_after_non_negative', expression: 'balance_after >= 0' })
@Check({
  name: 'chk_ledger_math',
  expression:
    "(direction = 'CREDIT' AND balance_before + amount = balance_after) OR (direction = 'DEBIT' AND balance_before - amount = balance_after)",
})
@Index({ name: 'idx_ledger_wallet_pagination', properties: ['walletId', 'createdAt', 'id'] })
@Index({ name: 'idx_ledger_transaction_id', properties: ['transactionId'] })
export class WalletLedgerEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ type: 'string', name: 'wallet_id' })
  walletId!: string;

  @Property({ type: 'string', name: 'transaction_id' })
  transactionId!: string;

  @Property({ type: 'string', length: 10 })
  direction!: string;

  @Property({ type: 'decimal', precision: 15, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 15, scale: 2, name: 'balance_before' })
  balanceBefore!: string;

  @Property({ type: 'decimal', precision: 15, scale: 2, name: 'balance_after' })
  balanceAfter!: string;

  @Property({ type: 'timestamptz', defaultRaw: 'NOW()', name: 'created_at' })
  createdAt: Date = new Date();
}
