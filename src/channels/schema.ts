import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * What a thing is called on the other side.
 *
 * Without this, projecting the same product twice creates two listings, and
 * an order arriving from the channel cannot be traced back to anything.
 */
export const channelMappings = pgTable(
  'channel_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull(),
    /** `product`, `variant`, `customer` or `order`. */
    entityType: text('entity_type').notNull(),
    localId: text('local_id').notNull(),
    externalId: text('external_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('channel_mappings_local_key').on(table.channel, table.entityType, table.localId),
    uniqueIndex('channel_mappings_external_key').on(table.channel, table.entityType, table.externalId),
  ],
)

/**
 * Per-channel selling rules for one variant.
 *
 * A row per channel rather than a flag on the variant: the same product is
 * often listed on the shop and withheld from a marketplace, and a single flag
 * forces that decision to be the same everywhere.
 */
export const channelPublications = pgTable(
  'channel_publications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull(),
    variantLocalId: text('variant_local_id').notNull(),
    listed: boolean('listed').notNull().default(true),
    priceShown: boolean('price_shown').notNull().default(true),
    orderable: boolean('orderable').notNull().default(true),
    /** Which price list this channel presents. Null means the default. */
    priceList: text('price_list'),
    /** Units held back from this channel, against the lag in propagation. */
    stockBuffer: integer('stock_buffer').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('channel_publications_key').on(table.channel, table.variantLocalId),
    index('channel_publications_listed_idx').on(table.channel, table.listed),
  ],
)

/**
 * Orders as the channel delivered them.
 *
 * Recorded before anything is interpreted, so a line naming an unknown variant
 * parks the order for a person instead of losing it - an order that cannot be
 * understood is still an order somebody placed and paid for.
 */
export const channelInboxOrders = pgTable(
  'channel_inbox_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    /** `accepted`, `parked` or `oversold`. */
    state: text('state').notNull(),
    parkedReason: text('parked_reason'),
    currency: text('currency').notNull(),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    counterpartyId: uuid('counterparty_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('channel_inbox_orders_key').on(table.channel, table.externalId),
    index('channel_inbox_orders_state_idx').on(table.channel, table.state),
  ],
)

/** Work owed to a channel: what to send, and how often we have tried. */
export const channelOutbound = pgTable(
  'channel_outbound',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull(),
    /** `product`, `stock`, `price`, `order_status` or `unpublish`. */
    kind: text('kind').notNull(),
    /** Identifies what the item is about, so a newer item can replace it. */
    subject: text('subject').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('channel_outbound_subject_key').on(table.channel, table.kind, table.subject),
    index('channel_outbound_ready_idx').on(table.channel, table.availableAt),
  ],
)

/** Differences found between what the core published and what a channel shows. */
export const channelDrift = pgTable(
  'channel_drift',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull(),
    /** `stock`, `content`, `presence` or `price`. */
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    expected: text('expected'),
    actual: text('actual'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [index('channel_drift_open_idx').on(table.channel, table.resolvedAt)],
)

/**
 * The customer as the core knows them.
 *
 * Minimal on purpose: this change owns only enough of a counterparty to attach
 * an order and choose a price list. The rest arrives with the counterparties
 * capability.
 */
export const counterparties = pgTable(
  'counterparties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    /** Determines which price list a channel presents to them. */
    customerGroup: text('customer_group'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('counterparties_email_idx').on(table.email),
    index('counterparties_phone_idx').on(table.phone),
  ],
)

/** Which channel identity belongs to which counterparty. */
export const counterpartyIdentities = pgTable(
  'counterparty_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    counterpartyId: uuid('counterparty_id')
      .notNull()
      .references(() => counterparties.id, { onDelete: 'cascade' }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('counterparty_identities_key').on(table.channel, table.externalId),
    index('counterparty_identities_party_idx').on(table.counterpartyId),
  ],
)

/** Where order fetching left off, per channel. */
export const channelState = pgTable('channel_state', {
  channel: text('channel').primaryKey(),
  lastOrderFetchAt: timestamp('last_order_fetch_at', { withTimezone: true }),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type ChannelMappingRow = typeof channelMappings.$inferSelect
export type ChannelPublicationRow = typeof channelPublications.$inferSelect
export type ChannelInboxOrderRow = typeof channelInboxOrders.$inferSelect
export type ChannelOutboundRow = typeof channelOutbound.$inferSelect
export type ChannelDriftRow = typeof channelDrift.$inferSelect
export type CounterpartyRow = typeof counterparties.$inferSelect

/**
 * Payment facts as they reached the core.
 *
 * A channel saying an order is paid is a claim, not a fact; this table holds
 * what actually arrived, keyed by the provider's own reference so a repeated
 * notification cannot be counted twice. The ledger is built from these, and the
 * order's paid status is published outward from here - never accepted inward.
 */
export const channelPayments = pgTable(
  'channel_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull(),
    externalOrderId: text('external_order_id').notNull(),
    /** The provider's identifier for this payment. The idempotency key. */
    reference: text('reference').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex('channel_payments_reference_key').on(table.channel, table.reference),
    index('channel_payments_order_idx').on(table.channel, table.externalOrderId),
  ],
)

export type ChannelPaymentRow = typeof channelPayments.$inferSelect
