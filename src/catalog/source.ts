import type { CatalogSource, ChannelProductInput, ChannelVariantInput } from '../channels/index.js'
import type { Database } from '../db/client.js'
import { type PriceList, Pricing } from '../pricing/pricing.js'
import { Attributes } from './attributes.js'
import { Images } from './images.js'
import { Catalog, type Product, type Variant } from './products.js'
import { Taxonomy } from './taxonomy.js'

export interface CatalogChannelSourceOptions {
  /** Price list whose amount rides on the variant itself. Defaults to the default list. */
  readonly priceListCode?: string
  /** Language the channel is fed. Defaults to the tenant's fallback language. */
  readonly language?: string
}

/**
 * The catalog, in the shape a sales channel reads.
 *
 * Implements the port the channel contract already declares rather than
 * inventing a second shape: a translator between our catalog and our own
 * contract would mean one of the two forms is unnecessary.
 *
 * The interesting decision is here: a variant with no price in the list an
 * audience is shown is reported as restricted to the groups that do have one.
 * The channel layer already refuses to project a group-restricted product to a
 * channel that cannot enforce groups, so a professional line priced only for
 * salons is absent from retail without any new rule - and a marketplace that
 * cannot tell customers apart never receives it at all.
 */
export class CatalogChannelSource implements CatalogSource {
  private readonly catalog: Catalog
  private readonly pricing: Pricing
  private readonly attributes: Attributes
  private readonly images: Images
  private readonly taxonomy: Taxonomy

  constructor(
    db: Database,
    private readonly options: CatalogChannelSourceOptions = {},
  ) {
    this.catalog = new Catalog(db)
    this.pricing = new Pricing(db)
    this.attributes = new Attributes(db)
    this.images = new Images(db)
    this.taxonomy = new Taxonomy(db)
  }

  async productFor(productLocalId: string): Promise<ChannelProductInput | null> {
    const product = await this.catalog.find(productLocalId)
    // A draft has never been on sale and a withdrawn one must come off: both
    // answer "nothing", and the channel layer takes the listing down.
    if (product === null || product.status !== 'published') return null

    const priceList =
      this.options.priceListCode === undefined
        ? await this.pricing.defaultPriceList()
        : await this.pricing.priceListByCode(this.options.priceListCode)

    const languages = await this.catalog.languages()
    const text = pickText(product.texts, this.options.language ?? languages.fallback, languages)

    const { variants, restrictions } = await this.projectVariants(
      product,
      priceList,
      text?.title ?? undefined,
    )

    // Every variant priced elsewhere: the product does not belong on this
    // channel's shelves for this audience at all.
    if (variants.length === 0 && restrictions.size === 0) return null

    const [media, attributes, brand, categories] = await Promise.all([
      this.images.of(product.id),
      product.variants[0] === undefined ? Promise.resolve([]) : this.attributes.of(product.variants[0].id),
      product.brandId === null
        ? Promise.resolve(null)
        : this.taxonomy.listBrands().then((all) => all.find((entry) => entry.id === product.brandId) ?? null),
      this.categoryNames(product),
    ])

    return {
      localId: product.id,
      title: text?.title ?? product.legacyId ?? product.id,
      ...(text?.description == null ? {} : { description: text.description }),
      ...(brand === null ? {} : { brand: brand.name }),
      ...(categories.length === 0 ? {} : { categories }),
      ...(attributes.length === 0
        ? {}
        : {
            attributes: Object.fromEntries(attributes.map((attribute) => [attribute.code, attribute.value])),
          }),
      ...(media.length === 0
        ? {}
        : {
            media: media.map((image) => ({
              url: image.url,
              ...(image.alt === null ? {} : { alt: image.alt }),
              position: image.position,
            })),
          }),
      variants,
      ...(restrictions.size === 0 ? {} : { restrictedToGroups: [...restrictions] }),
    }
  }

  /**
   * The variants this audience may be quoted, and who the rest are for.
   *
   * A variant with no price in this list is not missing data: it is priced for
   * somebody else, and saying so is what keeps a professional line off a retail
   * shelf.
   */
  private async projectVariants(
    product: Product,
    priceList: PriceList,
    fallbackTitle: string | undefined,
  ): Promise<{ variants: ChannelVariantInput[]; restrictions: Set<string> }> {
    const variants: ChannelVariantInput[] = []
    const restrictions = new Set<string>()

    for (const variant of product.variants) {
      for (const group of variant.restrictedToGroups) restrictions.add(group)

      const amount = await this.pricing.amountOf(variant.id, priceList.id, priceList.currency)
      if (amount === null) {
        for (const group of await this.groupsWithAPrice(variant)) restrictions.add(group)
        continue
      }

      variants.push({
        localId: variant.id,
        sku: variant.sku,
        title: variant.title ?? fallbackTitle ?? variant.sku,
        priceMinor: amount,
        currency: priceList.currency,
        ...(variant.barcode === null ? {} : { barcode: variant.barcode }),
        ...(variant.weightGrams === null ? {} : { weightGrams: variant.weightGrams }),
      })
    }

    return { variants, restrictions }
  }

  async productIdForVariant(variantLocalId: string): Promise<string | null> {
    return this.catalog.productIdForVariant(variantLocalId)
  }

  /** Customer groups whose price list holds an amount for this variant. */
  private async groupsWithAPrice(variant: Variant): Promise<string[]> {
    if (variant.restrictedToGroups.length > 0) return [...variant.restrictedToGroups]

    const lists = await this.pricing.listPriceLists()
    const groups: string[] = []
    for (const list of lists) {
      if (list.isDefault) continue
      const amount = await this.pricing.amountOf(variant.id, list.id, list.currency)
      if (amount === null) continue
      // The restriction names the audience, not the price list: a channel
      // enforces who may buy, and knows nothing of our lists.
      groups.push(...(await this.pricing.groupsShownPriceList(list.id)))
    }
    return groups
  }

  private async categoryNames(product: Product): Promise<string[]> {
    if (product.categoryIds.length === 0) return []
    const all = await this.taxonomy.listCategories()
    return all
      .filter((category) => product.categoryIds.includes(category.id))
      .map((category) => category.name)
  }
}

/**
 * The text a channel is given, or nothing.
 *
 * A language the tenant does not publish is deliberately not a candidate: a
 * Russian description kept for reference must not appear on a Ukrainian shop
 * because the Ukrainian one has not been written yet. An untranslated product
 * shows as untranslated, which someone can then fix.
 */
function pickText<T extends { language: string }>(
  texts: readonly T[],
  wanted: string,
  languages: { published: readonly string[]; fallback: string },
): T | null {
  const publishable = texts.filter((entry) => languages.published.includes(entry.language))
  return (
    publishable.find((entry) => entry.language === wanted) ??
    publishable.find((entry) => entry.language === languages.fallback) ??
    null
  )
}
