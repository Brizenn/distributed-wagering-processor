import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../domain/wallet/wallet-ledger-entry';
import { Money } from '../../../domain/common/money';
import { WalletLedgerEntity } from '../entities/wallet-ledger.entity';

export class WalletLedgerMapper {
  public static toDomain(entity: WalletLedgerEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction as LedgerDirection,
      money: Money.from({ amount: entity.amount, currency: entity.currency }),
      balanceBefore: Money.from({ amount: entity.balanceBefore, currency: entity.currency }),
      balanceAfter: Money.from({ amount: entity.balanceAfter, currency: entity.currency }),
      createdAt: entity.createdAt,
    });
  }

  public static toEntity(domain: WalletLedgerEntry): WalletLedgerEntity {
    const entity = new WalletLedgerEntity();
    entity.id = domain.id;
    entity.walletId = domain.walletId;
    entity.transactionId = domain.transactionId;
    entity.direction = domain.direction;
    entity.amount = domain.money.amount;
    entity.currency = domain.money.currency;
    entity.balanceBefore = domain.balanceBefore.amount;
    entity.balanceAfter = domain.balanceAfter.amount;
    entity.createdAt = domain.createdAt;
    return entity;
  }
}
