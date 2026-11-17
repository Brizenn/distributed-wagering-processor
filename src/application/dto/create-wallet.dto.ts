import { IsNotEmpty, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MoneyDto } from './money.dto';

export class CreateWalletDto {
  @IsNotEmpty()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  @IsNotEmpty()
  initialBalance!: MoneyDto;
}
