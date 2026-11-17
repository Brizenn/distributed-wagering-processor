import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './domain-error';

export interface MoneyProps {
  amount: string;   // decimal string, e.g.: "25.00"
  currency: string; // ISO-4217, e.g.: "BRL"
}

export class Money {
  private static readonly DECIMAL_REGEX = /^\d+(\.\d{1,2})?$/;
  private static readonly CURRENCY_REGEX = /^[A-Z]{3}$/;

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  public static from(props: MoneyProps): Money {
    if (!props) {
      throw new InvalidMoneyError('Money properties are required');
    }

    const { amount, currency } = props;

    if (typeof currency !== 'string' || !this.CURRENCY_REGEX.test(currency.trim())) {
      throw new InvalidMoneyError(`Invalid currency code: ${currency}`);
    }

    if (typeof amount !== 'string' || amount.trim() === '') {
      throw new InvalidMoneyError('Amount must be a non-empty string');
    }

    const trimmedAmount = amount.trim();

    // Reject scientific notation, negative numbers, or invalid decimal shapes
    if (
      trimmedAmount.includes('e') ||
      trimmedAmount.includes('E') ||
      trimmedAmount.startsWith('-') ||
      !this.DECIMAL_REGEX.test(trimmedAmount)
    ) {
      throw new InvalidMoneyError(
        `Invalid amount format: "${amount}". Must be non-negative with at most 2 decimal places.`,
      );
    }

    let dec: Decimal;
    try {
      dec = new Decimal(trimmedAmount);
    } catch {
      throw new InvalidMoneyError(`Cannot parse amount to Decimal: "${amount}"`);
    }

    if (!dec.isFinite()) {
      throw new InvalidMoneyError(`Amount is not finite: "${amount}"`);
    }

    return new Money(dec, currency.trim());
  }

  public static zero(currency: string): Money {
    if (typeof currency !== 'string' || !this.CURRENCY_REGEX.test(currency.trim())) {
      throw new InvalidMoneyError(`Invalid currency code: ${currency}`);
    }
    return new Money(new Decimal('0.00'), currency.trim());
  }

  /** Internal factory allowing negative decimals (e.g. from negate or calculations) */
  private static fromDecimal(value: Decimal, currency: string): Money {
    return new Money(value, currency);
  }

  public get amount(): string {
    return this.value.toFixed(2);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.plus(other.value), this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.minus(other.value), this.currency);
  }

  public negate(): Money {
    return Money.fromDecimal(this.value.negated(), this.currency);
  }

  public isZero(): boolean {
    return this.value.isZero();
  }

  public isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  public isNegative(): boolean {
    return this.value.isNegative();
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  public equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  public toJSON(): MoneyProps {
    return {
      amount: this.amount,
      currency: this.currency,
    };
  }

  public toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `Currency mismatch: cannot operate between ${this.currency} and ${other.currency}`,
      );
    }
  }
}
