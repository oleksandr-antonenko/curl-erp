import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

/**
 * PostgreSQL's 64-bit transaction id.
 *
 * Recorded on every event so a reader can tell which rows are settled. Without
 * it the journal has a hole nobody notices: sequence numbers are handed out
 * when a row is inserted but rows become visible when the transaction commits,
 * so a slower transaction can commit event 41 after a reader has already
 * consumed event 42 - and event 41 is then skipped forever.
 */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'xid8'
  },
})

export const changeEvents = pgTable(
  'change_events',
  {
    /** Monotonic within the tenant. The consumer cursor points at one of these. */
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    xactId: xid8('xact_id').notNull().default(sql`pg_current_xact_id()`),

    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    /** `created`, `updated` or `deleted`. */
    kind: text('kind').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    /** Who caused the change: `human`, `integration` or `bot`. */
    actorType: text('actor_type'),
    actorId: text('actor_id'),
    /** For bots, the conversation the action belongs to. */
    actorConversationId: text('actor_conversation_id'),

    /** Names of the fields that changed. Never their values. */
    changedFields: jsonb('changed_fields').$type<string[]>(),
  },
  (table) => [
    index('change_events_entity_idx').on(table.entityType, table.entityId, table.id),
    index('change_events_xact_idx').on(table.xactId),
  ],
)

export const feedConsumers = pgTable('feed_consumers', {
  name: text('name').primaryKey(),
  /** Highest event this consumer has acknowledged. Starts before the first. */
  cursor: bigint('cursor', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastAcknowledgedAt: timestamp('last_acknowledged_at', { withTimezone: true }),
})

/**
 * Events a consumer could not process.
 *
 * Kept per consumer, not per event: one consumer choking on a row must not stop
 * the others, and the row itself is usually fine.
 */
export const feedFailures = pgTable(
  'feed_failures',
  {
    consumer: text('consumer').notNull(),
    eventId: bigint('event_id', { mode: 'number' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    firstFailedAt: timestamp('first_failed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set once the consumer gave up and moved on. */
    parkedAt: timestamp('parked_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.consumer, table.eventId] }),
    index('feed_failures_parked_idx').on(table.consumer, table.parkedAt),
  ],
)

export type ChangeEventRow = typeof changeEvents.$inferSelect
export type NewChangeEventRow = typeof changeEvents.$inferInsert
export type FeedConsumerRow = typeof feedConsumers.$inferSelect
export type FeedFailureRow = typeof feedFailures.$inferSelect
