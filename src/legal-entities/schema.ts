import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/*
 * The businesses inside one tenant.
 *
 * A tenant is a customer of this ERP; a legal entity is a sole proprietor or a
 * company inside that customer. Stock and catalog belong to the tenant and are
 * shared; money, documents and their numbers also belong to an entity. Two sole
 * proprietors selling from one warehouse are one tenant with two entities - as
 * two tenants their stock would be counted twice.
 */
export const legalEntities = pgTable(
  'legal_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** National registry code (ЄДРПОУ / РНОКПП). Unique within the tenant. */
    registryCode: text('registry_code').notNull(),
    /** Where customers pay this entity. */
    iban: text('iban'),
    bankName: text('bank_name'),
    isActive: boolean('is_active').notNull().default(true),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('legal_entities_registry_code_key').on(table.registryCode)],
)

/**
 * Which entity an order paid by a given method is suggested to belong to.
 *
 * Method codes are the tenant's own vocabulary. The core ships none, so it
 * never has to name a payment provider.
 */
export const legalEntityPaymentDefaults = pgTable('legal_entity_payment_defaults', {
  paymentMethod: text('payment_method').primaryKey(),
  legalEntityId: uuid('legal_entity_id')
    .notNull()
    .references(() => legalEntities.id, { onDelete: 'restrict' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Old and new values of every change to an entity.
 *
 * The change feed records only which fields changed, by design - it is read by
 * integrations. Bank details are exactly what somebody will ask about later
 * ("which IBAN did we show customers in March?"), so their values live here.
 */
export const legalEntityChanges = pgTable(
  'legal_entity_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legalEntityId: uuid('legal_entity_id')
      .notNull()
      .references(() => legalEntities.id, { onDelete: 'restrict' }),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('legal_entity_changes_entity_idx').on(table.legalEntityId, table.changedAt)],
)

/**
 * The next number per entity and per kind of document.
 *
 * A row and an UPDATE rather than a PostgreSQL SEQUENCE: sequences are not
 * transactional, so a confirmation that rolls back would burn a number with no
 * trace of why it is missing.
 */
export const documentSequences = pgTable(
  'document_sequences',
  {
    legalEntityId: uuid('legal_entity_id')
      .notNull()
      .references(() => legalEntities.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    nextValue: integer('next_value').notNull(),
  },
  (table) => [primaryKey({ columns: [table.legalEntityId, table.kind] })],
)

export type LegalEntityRow = typeof legalEntities.$inferSelect
export type LegalEntityChangeRow = typeof legalEntityChanges.$inferSelect
