import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/*
 * The catalog.
 *
 * The variant is the unit everything counts in - stock, cost, price and order
 * lines all point at one. A product with a single variant is the common case and
 * must never force anyone to think about variants; a product with several must
 * not force the rest of the system to guess which one was meant.
 */

export const brands = pgTable(
  'brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logoUrl: text('logo_url'),
    /** Identifier in the system this was imported from. */
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('brands_slug_key').on(table.slug),
    uniqueIndex('brands_legacy_key').on(table.legacyId),
  ],
)

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    position: integer('position').notNull().default(0),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('categories_slug_key').on(table.slug),
    uniqueIndex('categories_legacy_key').on(table.legacyId),
    index('categories_parent_idx').on(table.parentId),
  ],
)

/** `draft` is invisible, `published` is projected, `withdrawn` is taken down. */
export const PRODUCT_STATUSES = ['draft', 'published', 'withdrawn'] as const

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Identifier in the shop this was imported from.
     *
     * Kept forever: it is the key every import profile matches on and the basis
     * of the redirect map when the domain moves.
     */
    legacyId: text('legacy_id'),
    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    primaryCategoryId: uuid('primary_category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('products_legacy_key').on(table.legacyId),
    index('products_status_idx').on(table.status),
    index('products_brand_idx').on(table.brandId),
  ],
)

export const productCategories = pgTable(
  'product_categories',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.categoryId] }),
    index('product_categories_category_idx').on(table.categoryId),
  ],
)

/**
 * Text, one row per language.
 *
 * Not a JSON column holding every language: a full-text index is built per
 * language with its own dictionary, and there is no way to build one inside a
 * JSON document. It also makes "how many products have no English title" a
 * count rather than a scan.
 */
export const productTexts = pgTable(
  'product_texts',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    language: text('language').notNull(),
    title: text('title'),
    shortDescription: text('short_description'),
    description: text('description'),
    metaTitle: text('meta_title'),
    metaDescription: text('meta_description'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.productId, table.language] })],
)

export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    barcode: text('barcode'),
    /** Manufacturer part number. */
    mpn: text('mpn'),
    supplierReference: text('supplier_reference'),
    legacyId: text('legacy_id'),
    title: text('title'),
    /**
     * What the supplier's list says this costs. A plan, not a cost: the cost of
     * goods sold comes from a receipt, and confusing the two is the quietest
     * way to report a margin that was never earned.
     */
    plannedPurchasePriceMinor: bigint('planned_purchase_price_minor', { mode: 'number' }),
    weightGrams: integer('weight_grams'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('product_variants_sku_key').on(table.sku),
    uniqueIndex('product_variants_barcode_key').on(table.barcode),
    uniqueIndex('product_variants_legacy_key').on(table.legacyId),
    index('product_variants_product_idx').on(table.productId),
  ],
)

/**
 * Groups allowed to see and buy a variant. No rows means everyone.
 *
 * A professional line has a price for salons and none for retail; the answer is
 * that retail does not see it at all, rather than seeing it without a price.
 */
export const variantGroupRestrictions = pgTable(
  'variant_group_restrictions',
  {
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    customerGroup: text('customer_group').notNull(),
  },
  (table) => [primaryKey({ columns: [table.variantId, table.customerGroup] })],
)

export const ATTRIBUTE_KINDS = ['text', 'number', 'boolean', 'option'] as const

/**
 * What an attribute means, declared once.
 *
 * Free key-value pairs are cheaper today and useless in six months: "250",
 * "250 ml" and "250ml" stop being one value, no filter can be built, and a bot
 * cannot answer "is this for coloured hair" because there is no field.
 */
export const attributeDefinitions = pgTable(
  'attribute_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    kind: text('kind').notNull(),
    label: text('label'),
    unit: text('unit'),
    /** Permitted values, for `option` attributes. */
    options: jsonb('options').$type<string[]>(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('attribute_definitions_code_key').on(table.code)],
)

export const variantAttributes = pgTable(
  'variant_attributes',
  {
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: 'cascade' }),
    textValue: text('text_value'),
    numberValue: doublePrecision('number_value'),
    booleanValue: boolean('boolean_value'),
    optionValue: text('option_value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.variantId, table.definitionId] }),
    index('variant_attributes_definition_idx').on(table.definitionId),
    index('variant_attributes_option_idx').on(table.definitionId, table.optionValue),
  ],
)

/**
 * Where a picture came from.
 *
 * A manufacturer's photograph, a competitor's, and a generated adaptation are
 * legally different things, and a year later the source cannot be recovered by
 * any means. A required field costs one dropdown; an optional one is never
 * filled in.
 */
export const IMAGE_ORIGINS = ['manufacturer', 'own_photography', 'generated', 'imported', 'other'] as const

export const productImages = pgTable(
  'product_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    alt: text('alt'),
    position: integer('position').notNull().default(0),
    origin: text('origin').notNull(),
    /** Required when the origin is `other`; free text otherwise. */
    originNote: text('origin_note'),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('product_images_product_idx').on(table.productId, table.position),
    index('product_images_origin_idx').on(table.origin),
  ],
)

/** Languages this tenant publishes, and the one it falls back to. */
export const catalogSettings = pgTable('catalog_settings', {
  id: integer('id').primaryKey().default(1),
  publishedLanguages: jsonb('published_languages').$type<string[]>().notNull().default(['uk']),
  defaultLanguage: text('default_language').notNull().default('uk'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const productRelations = relations(products, ({ many, one }) => ({
  variants: many(productVariants),
  texts: many(productTexts),
  images: many(productImages),
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
}))

export const variantRelations = relations(productVariants, ({ one, many }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
  attributes: many(variantAttributes),
  restrictions: many(variantGroupRestrictions),
}))

export type ProductRow = typeof products.$inferSelect
export type ProductVariantRow = typeof productVariants.$inferSelect
export type ProductTextRow = typeof productTexts.$inferSelect
export type BrandRow = typeof brands.$inferSelect
export type CategoryRow = typeof categories.$inferSelect
export type ProductImageRow = typeof productImages.$inferSelect
export type AttributeDefinitionRow = typeof attributeDefinitions.$inferSelect
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number]
export type ImageOrigin = (typeof IMAGE_ORIGINS)[number]

export { sql }
