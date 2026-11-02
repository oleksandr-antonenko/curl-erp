import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * A customer import run, from proposal to report - one row for both halves,
 * like the catalog import's, so "which report belongs to which proposal" is
 * never a question. Neither half holds personal data: see types.ts.
 */
export const customerImports = pgTable('customer_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull(),
  /** `proposed` or `applied`. */
  state: text('state').notNull().default('proposed'),
  proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
  proposedBy: text('proposed_by'),
  proposedByName: text('proposed_by_name'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  appliedBy: text('applied_by'),
  appliedByName: text('applied_by_name'),
  sourceRecords: integer('source_records').notNull().default(0),
  imported: integer('imported').notNull().default(0),
  merged: integer('merged').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  proposal: jsonb('proposal').notNull(),
  report: jsonb('report'),
  needsAttention: text('needs_attention'),
})

export type CustomerImportRow = typeof customerImports.$inferSelect
