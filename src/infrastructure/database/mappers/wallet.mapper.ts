import { Wallet } from '../../../domain/wallet/wallet';
import { Money } from '../../../domain/common/money';
import { WalletEntity } from '../entities/wallet.entity';

export class WalletMapper {
  public static toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({ amount: entity.balance, currency: entity.currency }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  public static updateEntity(domain: Wallet, target: WalletEntity): WalletEntity {
    target.balance = domain.balance.amount;
    target.version = domain.version;
    target.updatedAt = domain.updatedAt;
    return target;
  }

  public static toEntity(domain: Wallet): WalletEntity {
    const entity = new WalletEntity();
    entity.id = domain.id;
    entity.playerId = domain.playerId;
    entity.currency = domain.currency;
    entity.balance = domain.balance.amount;
    entity.version = domain.version;
    entity.createdAt = domain.createdAt;
    entity.updatedAt = domain.updatedAt;
    return entity;
  }
}
