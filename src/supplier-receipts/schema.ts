import {
  bigint,
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
import { contractors } from '../contractors/schema.js'
import { documents } from '../documents/schema.js'
import { legalEntities } from '../legal-entities/schema.js'
import { warehouses } from '../stock/schema.js'

/*
 * How goods and their cost get in.
 *
 * A receipt is a draft until a person posts it, and the draft is the same row
 * in a different state rather than a staging table: the corrections a person
 * makes belong on the record they will read a year later, beside what the
 * machine originally proposed.
 *
 * Posting records what is owed and never a payment. Goods arriving and money
 * leaving are separate events in separate amounts at separate times - one
 * payment can cover several deliveries, one delivery can be paid in parts. A
 * sibling system collapsed both into "expense"; posting a receipt there would
 * have counted 98 927,00 twice, in money that was already in its books, and
 * nothing would have shown it until a profit figure looked wrong.
 */
export const RECEIPT_STATES = ['draft', 'posted'] as const
export type ReceiptState = (typeof RECEIPT_STATES)[number]

export const supplierReceipts = pgTable(
  'supplier_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /* Numbering is per legal entity: two entities may each hold a document
     * numbered 8872, and a global unique index would reject the second. */
    legalEntityId: uuid('legal_entity_id')
      .notNull()
      .references(() => legalEntities.id, { onDelete: 'restrict' }),
    number: text('number'),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => contractors.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    /** The date on the supplier's document, not the day it was typed in. */
    documentDate: timestamp('document_date', { withTimezone: true }),
    /** The total printed on the supplier's document. Integer minor units. */
    statedTotalMinor: bigint('stated_total_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('UAH'),
    state: text('state').notNull().default('draft'),
    /** The evidence. Null is allowed, but then sourceNote is required. */
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'restrict' }),
    /** Where the figures came from when there is no document to point at. */
    sourceNote: text('source_note'),
    /** What the recogniser returned, kept as it came, beside the accepted values. */
    recognition: jsonb('recognition'),
    /** What we owe for this delivery. Set on posting; settled elsewhere. */
    obligationMinor: bigint('obligation_minor', { mode: 'number' }),
    createdActorType: text('created_actor_type').notNull(),
    createdActorId: text('created_actor_id').notNull(),
    createdActorConversationId: text('created_actor_conversation_id'),
    postedActorType: text('posted_actor_type'),
    postedActorId: text('posted_actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('supplier_receipts_entity_number_key').on(table.legalEntityId, table.number),
    index('supplier_receipts_supplier_idx').on(table.supplierId),
    index('supplier_receipts_state_idx').on(table.state),
  ],
)

/**
 * One printed line of the supplier's document, as printed.
 *
 * `rawName` is what the paper says and never changes; what it resolves to lives
 * in the parts below, because one printed line can be two different things on
 * our shelves - "Дозатор 24/410, 1 450 шт" is 750 for one bottle and 700 for
 * another, and the invoice has no column that says so.
 */
export const supplierReceiptLines = pgTable(
  'supplier_receipt_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => supplierReceipts.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    rawName: text('raw_name').notNull(),
    unit: text('unit'),
    quantity: integer('quantity').notNull(),
    /** This line's share of the total. Integer minor units, authoritative. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    /** What the recogniser read for this line, before a person touched it. */
    recognised: jsonb('recognised'),
  },
  (table) => [uniqueIndex('supplier_receipt_lines_position_key').on(table.receiptId, table.position)],
)

/** What a line turned out to be. A line resolves to one part or to several. */
export const supplierReceiptLineParts = pgTable(
  'supplier_receipt_line_parts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lineId: uuid('line_id')
      .notNull()
      .references(() => supplierReceiptLines.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    /** The lot this part created, once the receipt was posted. */
    lotId: uuid('lot_id'),
  },
  (table) => [index('supplier_receipt_line_parts_line_idx').on(table.lineId)],
)

export type SupplierReceiptRow = typeof supplierReceipts.$inferSelect
export type SupplierReceiptLineRow = typeof supplierReceiptLines.$inferSelect
export type SupplierReceiptLinePartRow = typeof supplierReceiptLineParts.$inferSelect
