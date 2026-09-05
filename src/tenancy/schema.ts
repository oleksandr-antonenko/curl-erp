import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Credentials for this tenant's integrations.
 *
 * Stored per tenant and encrypted at rest: a bank token or a carrier key is the
 * one piece of tenant data whose leak is immediate and irreversible, and a
 * shared store would put every customer's keys behind one mistake.
 */
export const tenantSecrets = pgTable(
  'tenant_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Dotted name, e.g. `bank.primary.token` or `channel.storefront.apiKey`. */
    name: text('name').notNull(),
    /** Base64 of nonce + ciphertext + auth tag. Never returned in plain text. */
    ciphertext: text('ciphertext').notNull(),
    /** Last four characters of the plain value, for recognising it in a list. */
    hint: text('hint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
  },
  (table) => [
    uniqueIndex('tenant_secrets_name_key').on(table.name),
    index('tenant_secrets_updated_idx').on(table.updatedAt),
  ],
)

export type TenantSecretRow = typeof tenantSecrets.$inferSelect
export type NewTenantSecretRow = typeof tenantSecrets.$inferInsert
