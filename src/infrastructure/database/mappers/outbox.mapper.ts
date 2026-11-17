import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { OutboxEntity } from '../entities/outbox.entity';

export class OutboxMapper {
  public static toDomain(entity: OutboxEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: entity.id,
      aggregateId: entity.aggregateId,
      eventType: entity.eventType,
      payload: entity.payload,
      occurredAt: entity.occurredAt,
      attempts: entity.attempts,
      nextAttemptAt: entity.nextAttemptAt,
      publishedAt: entity.publishedAt,
    });
  }

  public static toEntity(domain: OutboxMessage): OutboxEntity {
    const entity = new OutboxEntity();
    entity.id = domain.id;
    entity.aggregateId = domain.aggregateId;
    entity.eventType = domain.eventType;
    entity.payload = domain.payload as Record<string, unknown>;
    entity.occurredAt = domain.occurredAt;
    entity.attempts = domain.attempts;
    entity.nextAttemptAt = domain.nextAttemptAt;
    entity.publishedAt = domain.publishedAt;
    return entity;
  }
}
