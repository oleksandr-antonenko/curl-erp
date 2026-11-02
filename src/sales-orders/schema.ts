import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { productVariants } from '../catalog/schema.js'
import { channelInboxOrders } from '../channels/schema.js'
import { contractors } from '../contractors/schema.js'
import { legalEntities } from '../legal-entities/schema.js'

/*
 * A customer's order as the business accepted it.
 *
 * The inbox holds what a channel said, including what we could not interpret.
 * This holds only what was accepted: every line names a variant, the lines and
 * delivery make the total, and - once a person has confirmed it - the order
 * belongs to one legal entity and carries that entity's number.
 */
export const SALES_ORDER_STATUSES = ['new', 'confirmed', 'paid', 'shipped', 'cancelled', 'refunded'] as const
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number]

export const salesOrders = pgTable(
  'sales_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inboxOrderId: uuid('inbox_order_id')
      .notNull()
      .references(() => channelInboxOrders.id, { onDelete: 'restrict' }),
    channel: text('channel').notNull(),
    channelOrderId: text('channel_order_id').notNull(),
    contractorId: uuid('contractor_id')
      .notNull()
      .references(() => contractors.id, { onDelete: 'restrict' }),
    paymentMethod: text('payment_method'),
    /** What the system proposed. Never acted on without a person. */
    suggestedEntityId: uuid('suggested_entity_id').references(() => legalEntities.id, {
      onDelete: 'restrict',
    }),
    /** Null until a person confirms which entity the order belongs to. */
    legalEntityId: uuid('legal_entity_id').references(() => legalEntities.id, { onDelete: 'restrict' }),
    entityConfirmedByType: text('entity_confirmed_by_type'),
    entityConfirmedById: text('entity_confirmed_by_id'),
    entityConfirmedAt: timestamp('entity_confirmed_at', { withTimezone: true }),
    /** Issued at confirmation from the entity's sequence. */
    number: integer('number'),
    status: text('status').$type<SalesOrderStatus>().notNull(),
    currency: text('currency').notNull(),
    itemsMinor: bigint('items_minor', { mode: 'number' }).notNull(),
    shippingMinor: bigint('shipping_minor', { mode: 'number' }).notNull(),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    delivery: jsonb('delivery').$type<Record<string, unknown>>(),
    deliveryNote: text('delivery_note'),
    trackingReference: text('tracking_reference'),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sales_orders_inbox_key').on(table.inboxOrderId),
    uniqueIndex('sales_orders_entity_number_key').on(table.legalEntityId, table.number),
    index('sales_orders_status_idx').on(table.status),
    index('sales_orders_contractor_idx').on(table.contractorId),
  ],
)

export const salesOrderLines = pgTable(
  'sales_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => salesOrders.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    /** What the customer was charged for one, in minor units. Never repriced. */
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
    lineTotalMinor: bigint('line_total_minor', { mode: 'number' }).notNull(),
  },
  (table) => [uniqueIndex('sales_order_lines_position_key').on(table.orderId, table.position)],
)

/** A number an order held before its entity was changed. Never issued again. */
export const salesOrderWithdrawnNumbers = pgTable(
  'sales_order_withdrawn_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => salesOrders.id, { onDelete: 'restrict' }),
    legalEntityId: uuid('legal_entity_id')
      .notNull()
      .references(() => legalEntities.id, { onDelete: 'restrict' }),
    number: integer('number').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('sales_order_withdrawn_numbers_key').on(table.legalEntityId, table.number)],
)

/** Every status change and entity decision, with who made it. */
export const salesOrderEvents = pgTable(
  'sales_order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Order of events, including several written in one transaction. */
    sequence: bigserial('sequence', { mode: 'number' }).notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => salesOrders.id, { onDelete: 'restrict' }),
    /** `status`, `entity_confirmed` or `entity_changed`. */
    kind: text('kind').notNull(),
    fromValue: text('from_value'),
    toValue: text('to_value'),
    note: text('note'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sales_order_events_order_idx').on(table.orderId, table.occurredAt)],
)

/**
 * Money that arrived for an order. A fact, not a claim.
 *
 * `source` says how the fact reached us - a person, a provider, a bank
 * statement - and `reference` is that source's own identifier, so the same
 * payment announced twice is recorded once. The receiving entity is part of
 * the fact: money lands in one particular account.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => salesOrders.id, { onDelete: 'restrict' }),
    legalEntityId: uuid('legal_entity_id')
      .notNull()
      .references(() => legalEntities.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    source: text('source').notNull(),
    reference: text('reference').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('payments_source_reference_key').on(table.source, table.reference),
    index('payments_order_idx').on(table.orderId),
  ],
)

export type SalesOrderRow = typeof salesOrders.$inferSelect
export type SalesOrderLineRow = typeof salesOrderLines.$inferSelect
export type SalesOrderEventRow = typeof salesOrderEvents.$inferSelect
export type PaymentRow = typeof payments.$inferSelect
