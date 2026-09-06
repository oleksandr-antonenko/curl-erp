import { and, asc, eq, inArray } from 'drizzle-orm'
import { recordChange } from '../change-feed/record.js'
import type { Executor } from '../change-feed/types.js'
import type { Database } from '../db/client.js'
import { CatalogError, DuplicateIdentifierError, NotFoundError } from './errors.js'
import {
  catalogSettings,
  type ProductStatus,
  productCategories,
  products,
  productTexts,
  productVariants,
  variantGroupRestrictions,
} from './schema.js'

export interface VariantInput {
  readonly sku: string
  readonly title?: string
  readonly barcode?: string
  readonly mpn?: string
  readonly supplierReference?: string
  readonly legacyId?: string
  readonly plannedPurchasePriceMinor?: number
  readonly weightGrams?: number
  readonly position?: number
  /** Groups allowed to see and buy this. Empty means everyone. */
  readonly restrictedToGroups?: readonly string[]
}

export interface ProductTextInput {
  readonly language: string
  readonly title?: string
  readonly shortDescription?: string
  readonly description?: string
  readonly metaTitle?: string
  readonly metaDescription?: string
}

export interface ProductInput {
  readonly legacyId?: string
  readonly brandId?: string
  readonly primaryCategoryId?: string
  readonly categoryIds?: readonly string[]
  readonly status?: ProductStatus
  readonly texts: readonly ProductTextInput[]
  /** At least one. A product with none is not something anyone can sell. */
  readonly variants?: readonly VariantInput[]
}

export interface Variant {
  readonly id: string
  readonly productId: string
  readonly sku: string
  readonly title: string | null
  readonly barcode: string | null
  readonly mpn: string | null
  readonly supplierReference: string | null
  readonly legacyId: string | null
  readonly plannedPurchasePriceMinor: number | null
  readonly weightGrams: number | null
  readonly position: number
  readonly restrictedToGroups: readonly string[]
}

export interface ProductText {
  readonly language: string
  readonly title: string | null
  readonly shortDescription: string | null
  readonly description: string | null
  readonly metaTitle: string | null
  readonly metaDescription: string | null
}

export interface Product {
  readonly id: string
  readonly legacyId: string | null
  readonly brandId: string | null
  readonly primaryCategoryId: string | null
  readonly categoryIds: readonly string[]
  readonly status: ProductStatus
  readonly texts: readonly ProductText[]
  readonly variants: readonly Variant[]
}

export interface CatalogLanguages {
  readonly published: readonly string[]
  readonly fallback: string
}

/**
 * Products and the variants they sell through.
 *
 * Everything that counts - stock, cost, price, an order line - points at a
 * variant. A product with one variant is the common case here and must never
 * make anyone think about variants; the model still keeps the distinction,
 * because a system that counts products cannot later be taught to count sizes.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class Catalog {
  constructor(private readonly db: Database) {}

  async languages(): Promise<CatalogLanguages> {
    const [row] = await this.db.select().from(catalogSettings).limit(1)
    if (row === undefined) return { published: ['uk'], fallback: 'uk' }
    return { published: row.publishedLanguages, fallback: row.defaultLanguage }
  }

  async setLanguages(published: readonly string[], fallback: string): Promise<void> {
    if (!published.includes(fallback)) {
      throw new CatalogError(`The fallback language ${fallback} must be one that is published`)
    }
    await this.db
      .insert(catalogSettings)
      .values({ id: 1, publishedLanguages: [...published], defaultLanguage: fallback })
      .onConflictDoUpdate({
        target: catalogSettings.id,
        set: { publishedLanguages: [...published], defaultLanguage: fallback, updatedAt: new Date() },
      })
  }

  /**
   * Creates a product and its variants in one transaction.
   *
   * A product always ends up with at least one variant: given none, one is made
   * from the product itself, so the caller never has to think about it.
   */
  async create(input: ProductInput): Promise<Product> {
    const variants =
      input.variants !== undefined && input.variants.length > 0
        ? input.variants
        : [{ sku: input.legacyId ?? crypto.randomUUID() }]

    await this.assertIdentifiersFree(variants)

    const id = await this.db.transaction(async (tx) => {
      const [product] = await tx
        .insert(products)
        .values({
          legacyId: input.legacyId ?? null,
          brandId: input.brandId ?? null,
          primaryCategoryId: input.primaryCategoryId ?? null,
          status: input.status ?? 'draft',
        })
        .returning({ id: products.id })
      if (product === undefined) throw new CatalogError('Failed to create product')

      await this.writeTexts(tx, product.id, input.texts)
      await this.writeCategories(tx, product.id, input.categoryIds ?? [], input.primaryCategoryId)
      await this.writeVariants(tx, product.id, variants)

      await recordChange(tx, {
        entityType: 'product',
        entityId: product.id,
        kind: 'created',
      })
      return product.id
    })

    return this.get(id)
  }

  async get(id: string): Promise<Product> {
    const product = await this.find(id)
    if (product === null) throw new NotFoundError('product', id)
    return product
  }

  async find(id: string): Promise<Product | null> {
    const [row] = await this.db.select().from(products).where(eq(products.id, id)).limit(1)
    if (row === undefined) return null
    return this.hydrate(row)
  }

  async findByLegacyId(legacyId: string): Promise<Product | null> {
    const [row] = await this.db.select().from(products).where(eq(products.legacyId, legacyId)).limit(1)
    if (row === undefined) return null
    return this.hydrate(row)
  }

  async findVariantBySku(sku: string): Promise<Variant | null> {
    const [row] = await this.db.select().from(productVariants).where(eq(productVariants.sku, sku)).limit(1)
    return row === undefined ? null : this.hydrateVariant(row)
  }

  /** Replaces a product's text for the languages given; others are left alone. */
  async setTexts(productId: string, texts: readonly ProductTextInput[]): Promise<Product> {
    await this.db.transaction(async (tx) => {
      await this.writeTexts(tx, productId, texts)
      await recordChange(tx, {
        entityType: 'product',
        entityId: productId,
        kind: 'updated',
        changedFields: texts.map((text) => `text.${text.language}`),
      })
    })
    return this.get(productId)
  }

  /**
   * Moves a product between draft, published and withdrawn.
   *
   * Withdrawing journals the change so the channels holding it are told to take
   * it down, rather than leaving a listing nobody manages.
   */
  async setStatus(productId: string, status: ProductStatus): Promise<Product> {
    const current = await this.get(productId)
    if (current.status === status) return current

    await this.db.transaction(async (tx) => {
      await tx.update(products).set({ status, updatedAt: new Date() }).where(eq(products.id, productId))
      await recordChange(tx, {
        entityType: 'product',
        entityId: productId,
        kind: status === 'withdrawn' ? 'deleted' : 'updated',
        changedFields: ['status'],
      })
    })

    return this.get(productId)
  }

  async setRestrictions(variantId: string, groups: readonly string[]): Promise<Variant> {
    await this.db.transaction(async (tx) => {
      await tx.delete(variantGroupRestrictions).where(eq(variantGroupRestrictions.variantId, variantId))
      if (groups.length > 0) {
        await tx
          .insert(variantGroupRestrictions)
          .values(groups.map((customerGroup) => ({ variantId, customerGroup })))
      }
      await recordChange(tx, {
        entityType: 'variant',
        entityId: variantId,
        kind: 'updated',
        changedFields: ['restrictedToGroups'],
      })
    })

    const variant = await this.findVariant(variantId)
    if (variant === null) throw new NotFoundError('variant', variantId)
    return variant
  }

  async findVariant(variantId: string): Promise<Variant | null> {
    const [row] = await this.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, variantId))
      .limit(1)
    return row === undefined ? null : this.hydrateVariant(row)
  }

  /** Which product a variant belongs to. Used by the channel contract. */
  async productIdForVariant(variantId: string): Promise<string | null> {
    // The id arrives from a channel, which may hold one we renumbered or never
    // issued. "We have no such variant" is the answer to that, not an error
    // that stops a whole synchronisation run.
    if (!UUID_PATTERN.test(variantId)) return null
    const [row] = await this.db
      .select({ productId: productVariants.productId })
      .from(productVariants)
      .where(eq(productVariants.id, variantId))
      .limit(1)
    return row?.productId ?? null
  }

  async listByStatus(status: ProductStatus): Promise<Product[]> {
    const rows = await this.db.select().from(products).where(eq(products.status, status))
    return Promise.all(rows.map(async (row) => this.hydrate(row)))
  }

  /**
   * Products missing a title in a language the tenant publishes.
   *
   * A count rather than a scan, which is the whole reason text is a row per
   * language instead of a document.
   */
  async incompleteIn(language: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: products.id, title: productTexts.title })
      .from(products)
      .leftJoin(
        productTexts,
        and(eq(productTexts.productId, products.id), eq(productTexts.language, language)),
      )
    return rows.filter((row) => row.title === null || row.title.trim() === '').map((row) => row.id)
  }

  // --- internals -----------------------------------------------------------

  private async assertIdentifiersFree(variants: readonly VariantInput[]): Promise<void> {
    const skus = variants.map((variant) => variant.sku)
    const clashes = await this.db
      .select({ id: productVariants.id, sku: productVariants.sku })
      .from(productVariants)
      .where(inArray(productVariants.sku, skus))
    const clash = clashes[0]
    if (clash !== undefined) {
      throw new DuplicateIdentifierError('sku', clash.sku, `variant ${clash.id}`)
    }

    const barcodes = variants
      .map((variant) => variant.barcode)
      .filter((barcode): barcode is string => barcode !== undefined && barcode !== '')
    if (barcodes.length === 0) return

    const barcodeClashes = await this.db
      .select({ id: productVariants.id, barcode: productVariants.barcode })
      .from(productVariants)
      .where(inArray(productVariants.barcode, barcodes))
    const barcodeClash = barcodeClashes[0]
    if (barcodeClash?.barcode != null) {
      throw new DuplicateIdentifierError('barcode', barcodeClash.barcode, `variant ${barcodeClash.id}`)
    }
  }

  private async writeTexts(
    executor: Executor,
    productId: string,
    texts: readonly ProductTextInput[],
  ): Promise<void> {
    for (const text of texts) {
      await executor
        .insert(productTexts)
        .values({
          productId,
          language: text.language,
          title: text.title ?? null,
          shortDescription: text.shortDescription ?? null,
          description: text.description ?? null,
          metaTitle: text.metaTitle ?? null,
          metaDescription: text.metaDescription ?? null,
        })
        .onConflictDoUpdate({
          target: [productTexts.productId, productTexts.language],
          set: {
            title: text.title ?? null,
            shortDescription: text.shortDescription ?? null,
            description: text.description ?? null,
            metaTitle: text.metaTitle ?? null,
            metaDescription: text.metaDescription ?? null,
            updatedAt: new Date(),
          },
        })
    }
  }

  private async writeCategories(
    executor: Executor,
    productId: string,
    categoryIds: readonly string[],
    primaryCategoryId: string | undefined,
  ): Promise<void> {
    const all = new Set(categoryIds)
    if (primaryCategoryId !== undefined) all.add(primaryCategoryId)
    if (all.size === 0) return

    await executor
      .insert(productCategories)
      .values([...all].map((categoryId) => ({ productId, categoryId })))
      .onConflictDoNothing()
  }

  private async writeVariants(
    executor: Executor,
    productId: string,
    variants: readonly VariantInput[],
  ): Promise<void> {
    for (const [index, variant] of variants.entries()) {
      const [row] = await executor
        .insert(productVariants)
        .values({
          productId,
          sku: variant.sku,
          title: variant.title ?? null,
          barcode: variant.barcode ?? null,
          mpn: variant.mpn ?? null,
          supplierReference: variant.supplierReference ?? null,
          legacyId: variant.legacyId ?? null,
          plannedPurchasePriceMinor: variant.plannedPurchasePriceMinor ?? null,
          weightGrams: variant.weightGrams ?? null,
          position: variant.position ?? index,
        })
        .returning({ id: productVariants.id })

      const groups = variant.restrictedToGroups ?? []
      if (row !== undefined && groups.length > 0) {
        await executor
          .insert(variantGroupRestrictions)
          .values(groups.map((customerGroup) => ({ variantId: row.id, customerGroup })))
      }
    }
  }

  private async hydrate(row: typeof products.$inferSelect): Promise<Product> {
    const [texts, variantRows, categoryRows] = await Promise.all([
      this.db.select().from(productTexts).where(eq(productTexts.productId, row.id)),
      this.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.productId, row.id))
        .orderBy(asc(productVariants.position)),
      this.db
        .select({ categoryId: productCategories.categoryId })
        .from(productCategories)
        .where(eq(productCategories.productId, row.id)),
    ])

    const variants = await Promise.all(variantRows.map(async (variant) => this.hydrateVariant(variant)))

    return {
      id: row.id,
      legacyId: row.legacyId,
      brandId: row.brandId,
      primaryCategoryId: row.primaryCategoryId,
      categoryIds: categoryRows.map((entry) => entry.categoryId),
      status: row.status as ProductStatus,
      texts: texts.map((text) => ({
        language: text.language,
        title: text.title,
        shortDescription: text.shortDescription,
        description: text.description,
        metaTitle: text.metaTitle,
        metaDescription: text.metaDescription,
      })),
      variants,
    }
  }

  private async hydrateVariant(row: typeof productVariants.$inferSelect): Promise<Variant> {
    const restrictions = await this.db
      .select({ customerGroup: variantGroupRestrictions.customerGroup })
      .from(variantGroupRestrictions)
      .where(eq(variantGroupRestrictions.variantId, row.id))

    return {
      id: row.id,
      productId: row.productId,
      sku: row.sku,
      title: row.title,
      barcode: row.barcode,
      mpn: row.mpn,
      supplierReference: row.supplierReference,
      legacyId: row.legacyId,
      plannedPurchasePriceMinor: row.plannedPurchasePriceMinor,
      weightGrams: row.weightGrams,
      position: row.position,
      restrictedToGroups: restrictions.map((entry) => entry.customerGroup),
    }
  }
}
