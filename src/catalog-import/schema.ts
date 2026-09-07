import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * An import run, from proposal to report.
 *
 * One row covers both halves deliberately: a proposal that was applied and a
 * report of what applying it did are the same event seen twice, and splitting
 * them makes "which report belongs to which proposal" a question someone has to
 * answer later, usually while a price is in dispute.
 */
export const catalogImports = pgTable('catalog_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Names the previous system, so runs against different sources are legible. */
  source: text('source').notNull(),
  /** `proposed`, `applied`, `superseded` or `failed`. */
  state: text('state').notNull().default('proposed'),
  proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
  proposedBy: text('proposed_by'),
  /**
   * The actor's name as it stood at the time.
   *
   * Stored beside the id, not looked up later: a report has to name whoever
   * ran it years afterwards, and by then they may have left and the id would
   * resolve to nothing. The id stays for linking, the name for reading.
   */
  proposedByName: text('proposed_by_name'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  appliedBy: text('applied_by'),
  appliedByName: text('applied_by_name'),
  /** Source record count, and the three states it must reconcile to. */
  sourceRecords: integer('source_records').notNull().default(0),
  imported: integer('imported').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  /** The proposal itself: what would be created, changed, withdrawn, refused. */
  proposal: jsonb('proposal').notNull(),
  /** Filled in on apply: reconciliation, gaps and failures. */
  report: jsonb('report'),
  /**
   * Set when the reconciliation did not come out even. An import in this state
   * is not a successful one, whatever else the numbers say.
   */
  needsAttention: text('needs_attention'),
})
