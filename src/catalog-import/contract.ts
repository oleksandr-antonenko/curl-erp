/**
 * What the import engine needs from a previous system, and nothing more.
 *
 * A port, deliberately: the engine decides what a proposal is, what counts as
 * accounted for and what a reconciliation compares, and it does that the same
 * way whichever shop the records came from. A reader knows one foreign schema
 * and none of our rules; the engine knows our rules and no foreign schema.
 */

/** A price as the previous system held it, before we work out what it meant. */
export interface LegacyPrice {
  /** Group the price applied to, in the previous system's own naming. */
  readonly group: string
  /**
   * The amount charged, in minor units, when the source stated one outright.
   * `null` when the source held it as a reduction from the retail price.
   */
  readonly amountMinor: number | null
  /** Reduction from the retail price, in minor units, when that is the form. */
  readonly reductionMinor: number | null
}

export interface LegacyText {
  readonly language: string
  readonly title: string
  readonly description?: string
  readonly shortDescription?: string
  readonly metaTitle?: string
  readonly metaDescription?: string
}

export interface LegacyImage {
  readonly url: string
  readonly position: number
  readonly alt?: string
}

/** One product as the previous system held it. */
export interface LegacyProduct {
  /** The previous system's identifier. The only thing matching relies on. */
  readonly legacyId: string
  readonly sku?: string
  readonly barcode?: string
  readonly active: boolean
  readonly texts: readonly LegacyText[]
  /** Retail price in minor units, or `null` where the source had none. */
  readonly retailMinor: number | null
  /** What the goods were expected to cost, in minor units. */
  readonly purchaseMinor: number | null
  readonly prices: readonly LegacyPrice[]
  readonly images: readonly LegacyImage[]
  readonly brand?: string
  readonly categories: readonly string[]
  readonly primaryCategory?: string
  readonly weightGrams?: number
}

/** A category as the previous system held it, for rebuilding the tree. */
export interface LegacyCategory {
  readonly legacyId: string
  readonly name: string
  readonly parentLegacyId: string | null
}

/**
 * Reads a previous system. Read-only by contract: the old shop keeps selling
 * while this runs, and an importer that can write to it is one bad query away
 * from taking the business down.
 */
export interface LegacyCatalogReader {
  /** Names the source in reports, so a reader can tell runs apart. */
  readonly sourceName: string
  readProducts(): Promise<readonly LegacyProduct[]>
  readCategories(): Promise<readonly LegacyCategory[]>
  /** Maps the source's group naming onto our customer group codes. */
  groupMapping(): Promise<Readonly<Record<string, string>>>
}
