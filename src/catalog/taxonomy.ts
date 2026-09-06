import { and, asc, count, eq, isNull, ne } from 'drizzle-orm'
import { recordChange } from '../change-feed/record.js'
import type { Database } from '../db/client.js'
import { CatalogError, DuplicateIdentifierError, NotFoundError } from './errors.js'
import { brands, categories, productCategories, products } from './schema.js'

export interface Brand {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly logoUrl: string | null
  readonly legacyId: string | null
}

export interface Category {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly slug: string
  readonly position: number
  readonly legacyId: string | null
}

export interface CategoryNode extends Category {
  readonly children: readonly CategoryNode[]
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Brands and categories.
 *
 * Both are first-class records rather than strings on a product: a brand's name,
 * logo and pricing rule are stated once, and renaming it does not mean editing
 * every product that carries it.
 */
export class Taxonomy {
  constructor(private readonly db: Database) {}

  // --- brands --------------------------------------------------------------

  async createBrand(input: {
    name: string
    slug?: string
    logoUrl?: string
    legacyId?: string
  }): Promise<Brand> {
    const slug = input.slug ?? slugify(input.name)
    const existing = await this.db
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.slug, slug))
      .limit(1)
    if (existing[0] !== undefined) {
      throw new DuplicateIdentifierError('slug', slug, `brand ${existing[0].id}`)
    }

    const [row] = await this.db
      .insert(brands)
      .values({
        name: input.name,
        slug,
        logoUrl: input.logoUrl ?? null,
        legacyId: input.legacyId ?? null,
      })
      .returning()
    if (row === undefined) throw new CatalogError('Failed to create brand')
    return toBrand(row)
  }

  async renameBrand(id: string, name: string): Promise<Brand> {
    const [row] = await this.db
      .update(brands)
      .set({ name, updatedAt: new Date() })
      .where(eq(brands.id, id))
      .returning()
    if (row === undefined) throw new NotFoundError('brand', id)
    return toBrand(row)
  }

  async listBrands(): Promise<Brand[]> {
    return (await this.db.select().from(brands).orderBy(asc(brands.name))).map(toBrand)
  }

  async findBrandByLegacyId(legacyId: string): Promise<Brand | null> {
    const [row] = await this.db.select().from(brands).where(eq(brands.legacyId, legacyId)).limit(1)
    return row === undefined ? null : toBrand(row)
  }

  // --- categories ----------------------------------------------------------

  async createCategory(input: {
    name: string
    slug?: string
    parentId?: string
    position?: number
    legacyId?: string
  }): Promise<Category> {
    const slug = input.slug ?? slugify(input.name)
    const clash = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, slug))
      .limit(1)
    if (clash[0] !== undefined) {
      throw new DuplicateIdentifierError('slug', slug, `category ${clash[0].id}`)
    }

    if (input.parentId !== undefined) {
      const parent = await this.db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.id, input.parentId))
        .limit(1)
      if (parent[0] === undefined) throw new NotFoundError('category', input.parentId)
    }

    const [row] = await this.db
      .insert(categories)
      .values({
        name: input.name,
        slug,
        parentId: input.parentId ?? null,
        position: input.position ?? 0,
        legacyId: input.legacyId ?? null,
      })
      .returning()
    if (row === undefined) throw new CatalogError('Failed to create category')
    return toCategory(row)
  }

  /**
   * Removes a category, refusing while anything still lives under it.
   *
   * Cascading instead would take products off the shop as a side effect of
   * tidying the menu.
   */
  async deleteCategory(id: string): Promise<void> {
    const [children] = await this.db
      .select({ value: count() })
      .from(categories)
      .where(eq(categories.parentId, id))
    const [used] = await this.db
      .select({ value: count() })
      .from(productCategories)
      .where(eq(productCategories.categoryId, id))

    const childCount = children?.value ?? 0
    const productCount = used?.value ?? 0
    if (childCount > 0 || productCount > 0) {
      throw new CatalogError(
        `Category ${id} still holds ${String(productCount)} product(s) and ` +
          `${String(childCount)} child categor(ies). Move them first.`,
      )
    }

    await this.db.delete(categories).where(eq(categories.id, id))
  }

  async listCategories(): Promise<Category[]> {
    return (
      await this.db.select().from(categories).orderBy(asc(categories.position), asc(categories.name))
    ).map(toCategory)
  }

  /** The category tree, roots first. */
  async categoryTree(): Promise<CategoryNode[]> {
    const flat = await this.listCategories()
    const byParent = new Map<string | null, Category[]>()
    for (const category of flat) {
      const siblings = byParent.get(category.parentId) ?? []
      siblings.push(category)
      byParent.set(category.parentId, siblings)
    }

    const build = (parentId: string | null): CategoryNode[] =>
      (byParent.get(parentId) ?? []).map((category) => ({
        ...category,
        children: build(category.id),
      }))

    return build(null)
  }

  async findCategoryByLegacyId(legacyId: string): Promise<Category | null> {
    const [row] = await this.db.select().from(categories).where(eq(categories.legacyId, legacyId)).limit(1)
    return row === undefined ? null : toCategory(row)
  }

  /** Products in a category, for the screen that answers "what is in here". */
  async productsIn(categoryId: string): Promise<string[]> {
    const rows = await this.db
      .select({ productId: productCategories.productId })
      .from(productCategories)
      .where(eq(productCategories.categoryId, categoryId))
    return rows.map((row) => row.productId)
  }

  /** Categories with no parent, used when importing a flat source. */
  async roots(): Promise<Category[]> {
    return (await this.db.select().from(categories).where(isNull(categories.parentId))).map(toCategory)
  }

  /** Journals a taxonomy change so channels and feeds see it. */
  async announce(entityType: 'brand' | 'category', entityId: string): Promise<void> {
    await recordChange(this.db, { entityType, entityId, kind: 'updated' })
  }

  /** Products whose brand is this one, for the rename test and for reporting. */
  async productsOfBrand(brandId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.brandId, brandId), ne(products.status, 'withdrawn')))
    return rows.map((row) => row.id)
  }
}

function toBrand(row: {
  id: string
  name: string
  slug: string
  logoUrl: string | null
  legacyId: string | null
}): Brand {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logoUrl,
    legacyId: row.legacyId,
  }
}

function toCategory(row: {
  id: string
  parentId: string | null
  name: string
  slug: string
  position: number
  legacyId: string | null
}): Category {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    slug: row.slug,
    position: row.position,
    legacyId: row.legacyId,
  }
}

export { slugify }
