import { Money } from '../common/money';
import { CurrencyMismatchError, InsufficientFundsError } from '../common/domain-error';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  public static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    createdAt?: Date;
  }): Wallet {
    const now = props.createdAt ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  public static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  public get balance(): Money {
    return this._balance;
  }

  public get version(): number {
    return this._version;
  }

  public get updatedAt(): Date {
    return this._updatedAt;
  }

  public debit(
    amount: Money,
    transactionId: string,
    ledgerEntryId: string,
    at: Date = new Date(),
  ): WalletLedgerEntry {
    this.assertSameCurrency(amount);

    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError(
        `Insufficient balance for debit. Current: ${this._balance}, Required: ${amount}`,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(amount);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;

    return WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Debit,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });
  }

  public credit(
    amount: Money,
    transactionId: string,
    ledgerEntryId: string,
    at: Date = new Date(),
  ): WalletLedgerEntry {
    this.assertSameCurrency(amount);

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(amount);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;

    return WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(
        `Wallet currency (${this.currency}) does not match operation currency (${money.currency})`,
      );
    }
  }
}
