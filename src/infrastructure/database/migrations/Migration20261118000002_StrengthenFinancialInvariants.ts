import { Migration } from '@mikro-orm/migrations';

/** Adds persistent response snapshots, retry scheduling, and ledger guards. */
export class Migration20261118000002_StrengthenFinancialInvariants extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN result_balance_amount NUMERIC(15, 2) NULL,
        ADD COLUMN result_balance_currency VARCHAR(3) NULL,
        ADD COLUMN reference_attempts INT NOT NULL DEFAULT 0,
        ADD COLUMN reference_next_attempt_at TIMESTAMPTZ NULL,
        ADD CONSTRAINT chk_wager_amount_non_negative CHECK (amount >= 0),
        ADD CONSTRAINT chk_wager_reference_attempts_non_negative CHECK (reference_attempts >= 0),
        ADD CONSTRAINT chk_wager_result_balance_pair CHECK (
          (result_balance_amount IS NULL AND result_balance_currency IS NULL) OR
          (result_balance_amount IS NOT NULL AND result_balance_currency IS NOT NULL AND result_balance_amount >= 0)
        ),
        ADD CONSTRAINT chk_wager_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        ADD CONSTRAINT chk_wager_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        ADD CONSTRAINT uq_wager_id_wallet UNIQUE (id, wallet_id);

      ALTER TABLE wallets
        ADD CONSTRAINT chk_wallet_version_positive CHECK (version >= 1),
        ADD CONSTRAINT uq_wallet_id_currency UNIQUE (id, currency);

      ALTER TABLE wallet_ledger
        ADD CONSTRAINT uq_ledger_one_entry_per_transaction UNIQUE (transaction_id),
        ADD CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        ADD CONSTRAINT chk_ledger_balance_before_non_negative CHECK (balance_before >= 0),
        ADD CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        ADD CONSTRAINT fk_ledger_transaction_wallet FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions(id, wallet_id);

      CREATE UNIQUE INDEX uq_processed_refund_reference_once
        ON wager_transactions(reference_transaction_id)
        WHERE kind = 'REFUND' AND status = 'PROCESSED' AND reference_transaction_id IS NOT NULL;
      CREATE UNIQUE INDEX uq_processed_rollback_reference_once
        ON wager_transactions(reference_transaction_id)
        WHERE kind = 'ROLLBACK' AND status = 'PROCESSED' AND reference_transaction_id IS NOT NULL;

      CREATE OR REPLACE FUNCTION reject_wallet_ledger_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger is append-only; % is not allowed', TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_wallet_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger
        FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();

      CREATE OR REPLACE FUNCTION reject_wallet_ledger_truncate()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger is append-only; TRUNCATE is not allowed';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_wallet_ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger
        FOR EACH STATEMENT EXECUTE FUNCTION reject_wallet_ledger_truncate();

      CREATE INDEX idx_wager_pending_reference_due
        ON wager_transactions(reference_next_attempt_at, created_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS idx_wager_pending_reference_due;
      DROP INDEX IF EXISTS uq_processed_rollback_reference_once;
      DROP INDEX IF EXISTS uq_processed_refund_reference_once;
      DROP TRIGGER IF EXISTS trg_wallet_ledger_no_truncate ON wallet_ledger;
      DROP TRIGGER IF EXISTS trg_wallet_ledger_immutable ON wallet_ledger;
      DROP FUNCTION IF EXISTS reject_wallet_ledger_truncate();
      DROP FUNCTION IF EXISTS reject_wallet_ledger_mutation();

      ALTER TABLE wallet_ledger
        DROP CONSTRAINT IF EXISTS fk_ledger_transaction_wallet,
        DROP CONSTRAINT IF EXISTS fk_ledger_wallet_currency,
        DROP CONSTRAINT IF EXISTS chk_ledger_balance_before_non_negative,
        DROP CONSTRAINT IF EXISTS chk_ledger_direction,
        DROP CONSTRAINT IF EXISTS uq_ledger_one_entry_per_transaction;

      ALTER TABLE wallets
        DROP CONSTRAINT IF EXISTS uq_wallet_id_currency,
        DROP CONSTRAINT IF EXISTS chk_wallet_version_positive;

      ALTER TABLE wager_transactions
        DROP CONSTRAINT IF EXISTS uq_wager_id_wallet,
        DROP CONSTRAINT IF EXISTS chk_wager_status,
        DROP CONSTRAINT IF EXISTS chk_wager_kind,
        DROP CONSTRAINT IF EXISTS chk_wager_result_balance_pair,
        DROP CONSTRAINT IF EXISTS chk_wager_reference_attempts_non_negative,
        DROP CONSTRAINT IF EXISTS chk_wager_amount_non_negative,
        DROP COLUMN IF EXISTS reference_next_attempt_at,
        DROP COLUMN IF EXISTS reference_attempts,
        DROP COLUMN IF EXISTS result_balance_currency,
        DROP COLUMN IF EXISTS result_balance_amount;
    `);
  }
}
