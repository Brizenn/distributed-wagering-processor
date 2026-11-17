import { Migration } from '@mikro-orm/migrations';

export class Migration20261117000001_InitialSchema extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      -- 1. wallets table
      CREATE TABLE IF NOT EXISTS wallets (
        id VARCHAR(255) PRIMARY KEY,
        player_id VARCHAR(255) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(15, 2) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_wallet_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency)
      );

      -- 2. wager_transactions table
      CREATE TABLE IF NOT EXISTS wager_transactions (
        id VARCHAR(255) PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id VARCHAR(255) NOT NULL REFERENCES wallets(id),
        player_id VARCHAR(255) NOT NULL,
        round_id VARCHAR(255) NOT NULL,
        game_id VARCHAR(255) NOT NULL,
        kind VARCHAR(50) NOT NULL,
        amount NUMERIC(15, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(255) NULL,
        reference_transaction_id VARCHAR(255) NULL REFERENCES wager_transactions(id),
        status VARCHAR(50) NOT NULL,
        failure_code VARCHAR(100) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL,
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_wager_tx_wallet_id ON wager_transactions(wallet_id);
      CREATE INDEX IF NOT EXISTS idx_wager_tx_status ON wager_transactions(status);
      CREATE INDEX IF NOT EXISTS idx_wager_tx_round_id ON wager_transactions(round_id);

      -- 3. wallet_ledger table
      CREATE TABLE IF NOT EXISTS wallet_ledger (
        id VARCHAR(255) PRIMARY KEY,
        wallet_id VARCHAR(255) NOT NULL REFERENCES wallets(id),
        transaction_id VARCHAR(255) NOT NULL REFERENCES wager_transactions(id),
        direction VARCHAR(10) NOT NULL,
        amount NUMERIC(15, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(15, 2) NOT NULL,
        balance_after NUMERIC(15, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_ledger_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT chk_ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT chk_ledger_math CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after) OR
          (direction = 'DEBIT' AND balance_before - amount = balance_after)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_wallet_pagination ON wallet_ledger(wallet_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_ledger_transaction_id ON wallet_ledger(transaction_id);

      -- 4. inbox table
      CREATE TABLE IF NOT EXISTS inbox (
        message_id VARCHAR(255) NOT NULL,
        consumer_name VARCHAR(100) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL,
        PRIMARY KEY (consumer_name, message_id)
      );

      -- 5. outbox table
      CREATE TABLE IF NOT EXISTS outbox (
        id VARCHAR(255) PRIMARY KEY,
        aggregate_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        published_at TIMESTAMPTZ NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_pending_due ON outbox(published_at, next_attempt_at);
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS outbox;
      DROP TABLE IF EXISTS inbox;
      DROP TABLE IF EXISTS wallet_ledger;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
    `);
  }
}
