import { boolean, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/*
 * The other side of an operation.
 *
 * A tax identifier is unique inside a tenant and never across tenants: two
 * businesses using this ERP may perfectly well buy from the same supplier, and
 * a global unique index would make the second one unable to record it.
 *
 * Roles are a list rather than a type, because the same company is often both
 * bought from and sold to, and splitting it in two would split its history.
 */
export const CONTRACTOR_ROLES = ['supplier', 'customer'] as const
export type ContractorRole = (typeof CONTRACTOR_ROLES)[number]

export const contractors = pgTable(
  'contractors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** National registry code (ЄДРПОУ / ІПН). Optional: a cash seller has none. */
    registryCode: text('registry_code'),
    taxCode: text('tax_code'),
    roles: text('roles').array().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    note: text('note'),
    /** Lower-case. Personal data for a person; never indexed or put in feeds. */
    email: text('email'),
    /** Digits only, so the same number written two ways is one number. */
    phone: text('phone'),
    /** The customer group that selects which price list they are quoted. */
    customerGroup: text('customer_group'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('contractors_registry_code_key').on(table.registryCode),
    uniqueIndex('contractors_tax_code_key').on(table.taxCode),
    index('contractors_name_idx').on(table.name),
    index('contractors_email_idx').on(table.email),
    index('contractors_phone_idx').on(table.phone),
  ],
)

/** Where a customer has asked for goods to go, as they wrote it. */
export const contractorAddresses = pgTable(
  'contractor_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contractorId: uuid('contractor_id')
      .notNull()
      .references(() => contractors.id, { onDelete: 'restrict' }),
    recipientName: text('recipient_name'),
    phone: text('phone'),
    city: text('city'),
    /** The address text as the customer wrote it. Not parsed. */
    addressText: text('address_text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('contractor_addresses_contractor_idx').on(table.contractorId)],
)

/**
 * Identifiers a contractor had in systems it was imported from.
 *
 * Several per contractor: two accounts in the previous shop with one email
 * address become one customer here, and both old ids must still find it. The
 * same table holds addresses' previous ids, distinguished by `source`.
 */
export const contractorLegacyIds = pgTable(
  'contractor_legacy_ids',
  {
    source: text('source').notNull(),
    legacyId: text('legacy_id').notNull(),
    contractorId: uuid('contractor_id')
      .notNull()
      .references(() => contractors.id, { onDelete: 'restrict' }),
    addressId: uuid('address_id').references(() => contractorAddresses.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.legacyId] }),
    index('contractor_legacy_ids_contractor_idx').on(table.contractorId),
  ],
)

export type ContractorRow = typeof contractors.$inferSelect
export type ContractorAddressRow = typeof contractorAddresses.$inferSelect
