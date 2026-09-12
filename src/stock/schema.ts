import { bigint, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { productVariants } from '../catalog/schema.js'

/*
 * What is on hand, and what it actually cost.
 *
 * Stock is held as lots, not as a number per item. A number per item cannot
 * answer "what did the ones we still have cost us", and it cannot be
 * reconstructed later - which is why lots are here from the first day even
 * though nothing consumes them yet.
 *
 * The amount is the authority; the per-unit figure is derived for display. A
 * delivery of 700 pieces for 28 100,00 is 40,142857... each, and a stored
 * per-unit value multiplied back gives 28 100,04 - four kopecks of permanent
 * disagreement with the bank, per delivery.
 */
export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('warehouses_code_key').on(table.code)],
)

export const stockLots = pgTable(
  'stock_lots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    quantityReceived: integer('quantity_received').notNull(),
    quantityRemaining: integer('quantity_remaining').notNull(),
    /** What this lot cost in total, integer minor units. The authority. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('UAH'),
    /** The document that brought this lot in. A lot never exists without one. */
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
  },
  (table) => [
    index('stock_lots_variant_idx').on(table.variantId, table.warehouseId),
    index('stock_lots_source_idx').on(table.sourceType, table.sourceId),
    index('stock_lots_received_idx').on(table.receivedAt),
  ],
)

export type WarehouseRow = typeof warehouses.$inferSelect
export type StockLotRow = typeof stockLots.$inferSelect
