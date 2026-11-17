import { MoneyProps } from '../../domain/common/money';

export interface WagerResultDto {
  transactionId: string;
  status: string;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}
