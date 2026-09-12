import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

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
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('contractors_registry_code_key').on(table.registryCode),
    uniqueIndex('contractors_tax_code_key').on(table.taxCode),
    index('contractors_name_idx').on(table.name),
  ],
)

export type ContractorRow = typeof contractors.$inferSelect
