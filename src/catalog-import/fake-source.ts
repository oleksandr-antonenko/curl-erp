import type { LegacyCatalogReader, LegacyCategory, LegacyProduct } from './contract.js'

/**
 * A stand-in for a previous system, shaped like the one we are leaving.
 *
 * Reproduces the forms that actually occur there - a price stated outright, a
 * price held as a reduction from retail, a product with no retail price at all,
 * one with no title - so the engine is exercised against the shapes it will
 * meet rather than against convenient ones.
 */
export class FakeLegacySource implements LegacyCatalogReader {
  readonly sourceName: string
  private products: LegacyProduct[]
  private categories: LegacyCategory[]
  private groups: Record<string, string>

  constructor(
    options: {
      sourceName?: string
      products?: LegacyProduct[]
      categories?: LegacyCategory[]
      groups?: Record<string, string>
    } = {},
  ) {
    this.sourceName = options.sourceName ?? 'previous shop'
    this.products = options.products ?? []
    this.categories = options.categories ?? []
    this.groups = options.groups ?? { hairdresser: 'wholesale' }
  }

  async readProducts(): Promise<readonly LegacyProduct[]> {
    return this.products
  }

  async readCategories(): Promise<readonly LegacyCategory[]> {
    return this.categories
  }

  async groupMapping(): Promise<Readonly<Record<string, string>>> {
    return this.groups
  }

  /** Lets a test change the source between proposing and applying. */
  replace(products: LegacyProduct[]): void {
    this.products = products
  }

  setCategories(categories: LegacyCategory[]): void {
    this.categories = categories
  }
}

/** A product with the fields a test does not care about already filled in. */
export function legacyProduct(input: Partial<LegacyProduct> & { legacyId: string }): LegacyProduct {
  return {
    active: true,
    texts: [{ language: 'uk', title: 'Крем' }],
    retailMinor: 49_900,
    purchaseMinor: 20_000,
    prices: [],
    images: [],
    categories: [],
    ...input,
  }
}
