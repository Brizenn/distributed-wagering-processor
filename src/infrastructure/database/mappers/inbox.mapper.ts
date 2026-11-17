import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { InboxEntity } from '../entities/inbox.entity';

export class InboxMapper {
  public static toDomain(entity: InboxEntity): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: entity.messageId,
      consumerName: entity.consumerName,
      payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt,
      processedAt: entity.processedAt,
    });
  }

  public static toEntity(domain: InboxMessage): InboxEntity {
    const entity = new InboxEntity();
    entity.messageId = domain.messageId;
    entity.consumerName = domain.consumerName;
    entity.payloadHash = domain.payloadHash;
    entity.receivedAt = domain.receivedAt;
    entity.processedAt = domain.processedAt;
    return entity;
  }
}
