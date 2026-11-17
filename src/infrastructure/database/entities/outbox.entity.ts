import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'outbox' })
@Index({ name: 'idx_outbox_pending_due', properties: ['publishedAt', 'nextAttemptAt'] })
export class OutboxEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ type: 'string', length: 255, name: 'aggregate_id' })
  aggregateId!: string;

  @Property({ type: 'string', length: 100, name: 'event_type' })
  eventType!: string;

  @Property({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;

  @Property({ type: 'integer', default: 0 })
  attempts: number = 0;

  @Property({ type: 'timestamptz', nullable: true, name: 'next_attempt_at' })
  nextAttemptAt?: Date;

  @Property({ type: 'timestamptz', nullable: true, name: 'published_at' })
  publishedAt?: Date;
}
