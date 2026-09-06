import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { brands, productVariants } from '../catalog/schema.js'

/*
 * What each customer pays.
 *
 * A price is always a number the business decided on. A percentage or a rule is
 * how that number was arrived at - recorded beside it, never in place of it.
 * The shop being replaced holds 325 of its 442 wholesale prices as "retail less
 * X", so editing a retail price silently moves what a hairdresser pays. Storing
 * the number makes a price a decision rather than a consequence.
 */

export const priceLists = pgTable(
  'price_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull().default('UAH'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('price_lists_code_key').on(table.code)],
)

export const customerGroups = pgTable(
  'customer_groups',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    priceListId: uuid('price_list_id').references(() => priceLists.id, { onDelete: 'restrict' }),
    isDefault: boolean('is_default').notNull().default(false),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('customer_groups_legacy_key').on(table.legacyId)],
)

/** How a stored amount was arrived at. */
export const PRICE_ORIGINS = ['stated', 'percentage', 'rule'] as const

export const variantPrices = pgTable(
  'variant_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull().default('UAH'),
    /** What is charged. Integer minor units; never a floating-point amount. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),

    origin: text('origin').notNull().default('stated'),
    /** For `percentage`: the list whose price this was computed from. */
    basisPriceListId: uuid('basis_price_list_id').references(() => priceLists.id, {
      onDelete: 'set null',
    }),
    /** For `percentage`: 7000 means 70%. Basis points avoid rounding drift. */
    factorBasisPoints: integer('factor_basis_points'),
    /** The amount the basis held when this was computed, so drift is visible. */
    basisAmountMinor: bigint('basis_amount_minor', { mode: 'number' }),
    ruleId: uuid('rule_id'),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
  },
  (table) => [
    uniqueIndex('variant_prices_key').on(table.variantId, table.priceListId, table.currency),
    index('variant_prices_list_idx').on(table.priceListId),
  ],
)

/**
 * Every amount a variant has ever had in a list.
 *
 * Append-only. A customer questioning last month's invoice needs the price that
 * was in force then, and the current row cannot answer that.
 */
export const variantPriceHistory = pgTable(
  'variant_price_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variantId: uuid('variant_id').notNull(),
    priceListId: uuid('price_list_id').notNull(),
    currency: text('currency').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    origin: text('origin').notNull(),
    factorBasisPoints: integer('factor_basis_points'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type'),
    actorId: text('actor_id'),
    /** Set when a guard was deliberately overridden to store this amount. */
    overrideReason: text('override_reason'),
  },
  (table) => [index('variant_price_history_key').on(table.variantId, table.priceListId, table.validFrom)],
)

export const PRICING_RULE_SCOPES = ['brand', 'supplier'] as const

/**
 * A default for a whole brand or supplier.
 *
 * The weakest of the three ways to set a price: a column in a file beats a
 * percentage, and a percentage beats this. A general rule overwriting a specific
 * agreement is how a price nobody intended reaches a customer.
 */
export const pricingRules = pgTable(
  'pricing_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull(),
    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'cascade' }),
    supplierCode: text('supplier_code'),
    targetPriceListId: uuid('target_price_list_id')
      .notNull()
      .references(() => priceLists.id, { onDelete: 'cascade' }),
    basisPriceListId: uuid('basis_price_list_id').references(() => priceLists.id, {
      onDelete: 'set null',
    }),
    /** 7000 means the target is 70% of the basis. */
    factorBasisPoints: integer('factor_basis_points').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('pricing_rules_brand_idx').on(table.brandId, table.targetPriceListId),
    index('pricing_rules_supplier_idx').on(table.supplierCode, table.targetPriceListId),
  ],
)

/**
 * The guards, and how far each may bend.
 *
 * Prices change a hundred rows at a time, and a warning inside a batch report is
 * read by nobody. A refusal makes somebody look.
 */
export const pricingSettings = pgTable('pricing_settings', {
  id: integer('id').primaryKey().default(1),
  /** No price may be stored below this. Zero disables the check. */
  minimumAmountMinor: bigint('minimum_amount_minor', { mode: 'number' }).notNull().default(0),
  /** Refuse a change moving the amount by more than this share. 5000 = 50%. */
  maximumChangeBasisPoints: integer('maximum_change_basis_points').notNull().default(5000),
  /** Refuse a wholesale price at or below the planned purchase price. */
  refuseAtOrBelowPurchase: boolean('refuse_at_or_below_purchase').notNull().default(true),
  /** Refuse a wholesale price at or above the retail price. */
  refuseAtOrAboveRetail: boolean('refuse_at_or_above_retail').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type PriceListRow = typeof priceLists.$inferSelect
export type CustomerGroupRow = typeof customerGroups.$inferSelect
export type VariantPriceRow = typeof variantPrices.$inferSelect
export type PricingRuleRow = typeof pricingRules.$inferSelect
export type PricingSettingsRow = typeof pricingSettings.$inferSelect
export type PriceOrigin = (typeof PRICE_ORIGINS)[number]
export type PricingRuleScope = (typeof PRICING_RULE_SCOPES)[number]
