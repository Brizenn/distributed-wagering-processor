import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class MoneyDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'Amount must be a non-negative decimal string with at most 2 decimal places',
  })
  amount!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{3}$/, {
    message: 'Currency must be an uppercase 3-letter ISO-4217 code (e.g. BRL)',
  })
  currency!: string;
}
