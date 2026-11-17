import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';

@Entity({ tableName: 'inbox' })
@Unique({ name: 'uq_inbox_consumer_message', properties: ['consumerName', 'messageId'] })
export class InboxEntity {
  @PrimaryKey({ type: 'string', name: 'message_id' })
  messageId!: string;

  @PrimaryKey({ type: 'string', length: 100, name: 'consumer_name' })
  consumerName!: string;

  @Property({ type: 'string', length: 64, name: 'payload_hash' })
  payloadHash!: string;

  @Property({ type: 'timestamptz', defaultRaw: 'NOW()', name: 'received_at' })
  receivedAt: Date = new Date();

  @Property({ type: 'timestamptz', nullable: true, name: 'processed_at' })
  processedAt?: Date;
}
