import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelCapabilities } from '../channels/contract.js'
import { decidePublication } from '../channels/publications.js'
import type { Database } from '../db/client.js'
import { Pricing } from '../pricing/pricing.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { Attributes } from './attributes.js'
import { Images } from './images.js'
import { Catalog } from './products.js'
import { CatalogChannelSource } from './source.js'
import { Taxonomy } from './taxonomy.js'

/** A marketplace: it lists and it sells, but every buyer looks the same to it. */
const channelThatCannotTellCustomersApart: ChannelCapabilities = {
  customerGroups: false,
  priceLists: false,
  stockLevels: true,
  orderStatus: true,
  stockReporting: false,
}

describe('the catalog as a channel reads it', () => {
  let fixture: TenantFixture
  let db: Database
  let catalog: Catalog
  let pricing: Pricing
  let taxonomy: Taxonomy
  let attributes: Attributes
  let images: Images
  let source: CatalogChannelSource

  beforeAll(async () => {
    fixture = await createTenantFixture(['source'], { migrate: true })
    db = fixture.registry.connectTo(fixture.tenant('source')).db
    catalog = new Catalog(db)
    pricing = new Pricing(db)
    taxonomy = new Taxonomy(db)
    attributes = new Attributes(db)
    images = new Images(db)
    source = new CatalogChannelSource(db, { language: 'uk' })
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(sql`
      truncate table variant_price_history, variant_prices, pricing_rules, price_lists,
        customer_groups, pricing_settings, product_images, variant_attributes,
        variant_group_restrictions, product_categories, product_texts, product_variants,
        products, attribute_definitions, categories, brands, catalog_settings, change_events
      restart identity cascade
    `)
    await catalog.setLanguages(['uk', 'en'], 'uk')
    await pricing.createPriceList({ code: 'retail', name: 'Роздріб', isDefault: true })
    await pricing.createPriceList({ code: 'wholesale', name: 'Опт' })
    await pricing.defineGroup({ code: 'professional', name: 'Перукарі', priceListCode: 'wholesale' })
  })

  async function publish(input: {
    legacyId: string
    title?: string
    sku?: string
    retailMinor?: number
    wholesaleMinor?: number
  }): Promise<string> {
    const sku = input.sku ?? input.legacyId
    const product = await catalog.create({
      legacyId: input.legacyId,
      texts: [{ language: 'uk', title: input.title ?? 'Крем' }],
      variants: [{ sku }],
    })
    const variantId = product.variants[0]?.id ?? ''
    if (input.retailMinor !== undefined) {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: input.retailMinor })
    }
    if (input.wholesaleMinor !== undefined) {
      await pricing.set({ variantId, priceListCode: 'wholesale', amountMinor: input.wholesaleMinor })
    }
    await catalog.setStatus(product.id, 'published')
    return product.id
  }

  describe('what reaches a channel at all', () => {
    it('withholds a draft', async () => {
      const product = await catalog.create({
        legacyId: 'p-1',
        texts: [{ language: 'uk', title: 'Крем' }],
      })
      await pricing.set({
        variantId: product.variants[0]?.id ?? '',
        priceListCode: 'retail',
        amountMinor: 49_900,
      })

      expect(await source.productFor(product.id)).toBeNull()
    })

    it('answers nothing for a withdrawn product, so the listing comes down', async () => {
      const id = await publish({ legacyId: 'p-1', retailMinor: 49_900 })
      expect(await source.productFor(id)).not.toBeNull()

      await catalog.setStatus(id, 'withdrawn')
      expect(await source.productFor(id)).toBeNull()
    })

    it('withholds a published product nobody has priced', async () => {
      const id = await publish({ legacyId: 'p-1' })
      expect(await source.productFor(id)).toBeNull()
    })
  })

  describe('a professional line', () => {
    it('is not projected at all to an audience that cannot buy it', async () => {
      const id = await publish({ legacyId: 'pro-1', title: 'Фарба', wholesaleMinor: 34_900 })

      // Not an empty listing with a note about who it is for: nothing this
      // audience may buy has no business on this channel's shelves.
      expect(await source.productFor(id)).toBeNull()
    })

    it('is projected, with its price, to the audience it is priced for', async () => {
      const id = await publish({ legacyId: 'pro-1', title: 'Фарба', wholesaleMinor: 34_900 })

      const wholesale = new CatalogChannelSource(db, {
        language: 'uk',
        priceListCode: 'wholesale',
      })
      const projected = await wholesale.productFor(id)

      expect(projected?.variants[0]).toMatchObject({ priceMinor: 34_900 })
    })

    it('carries the restriction when the variant is priced here but limited', async () => {
      const product = await catalog.create({
        legacyId: 'pro-2',
        texts: [{ language: 'uk', title: 'Оксид' }],
        variants: [{ sku: 'PRO-2', restrictedToGroups: ['professional'] }],
      })
      await pricing.set({
        variantId: product.variants[0]?.id ?? '',
        priceListCode: 'retail',
        amountMinor: 49_900,
      })
      await catalog.setStatus(product.id, 'published')

      const projected = await source.productFor(product.id)
      expect(projected?.restrictedToGroups).toEqual(['professional'])
      // Priced for this audience, so the variant travels; the restriction says
      // who may be shown it.
      expect(projected?.variants).toHaveLength(1)
    })

    it('is kept off a channel that cannot tell customers apart', async () => {
      const product = await catalog.create({
        legacyId: 'pro-3',
        texts: [{ language: 'uk', title: 'Тонер' }],
        variants: [{ sku: 'PRO-3', restrictedToGroups: ['professional'] }],
      })
      await pricing.set({
        variantId: product.variants[0]?.id ?? '',
        priceListCode: 'retail',
        amountMinor: 49_900,
      })
      await catalog.setStatus(product.id, 'published')

      const projected = await source.productFor(product.id)
      if (projected === null) throw new Error('expected a projection')

      expect(decidePublication(projected, channelThatCannotTellCustomersApart)).toMatchObject({
        publish: false,
        reason: expect.stringContaining('professional'),
      })
      expect(
        decidePublication(projected, { ...channelThatCannotTellCustomersApart, customerGroups: true }),
      ).toEqual({ publish: true })
    })

    it('leaves an unrestricted product free to go anywhere', async () => {
      const id = await publish({ legacyId: 'p-1', retailMinor: 49_900 })
      const projected = await source.productFor(id)
      if (projected === null) throw new Error('expected a projection')

      expect(projected.restrictedToGroups).toBeUndefined()
      expect(decidePublication(projected, channelThatCannotTellCustomersApart)).toEqual({
        publish: true,
      })
    })
  })

  describe('the shape a channel receives', () => {
    it('carries the price of the list this channel was pointed at', async () => {
      const wholesaleSource = new CatalogChannelSource(db, {
        language: 'uk',
        priceListCode: 'wholesale',
      })
      const id = await publish({
        legacyId: 'p-1',
        retailMinor: 49_900,
        wholesaleMinor: 34_900,
      })

      expect((await source.productFor(id))?.variants[0]?.priceMinor).toBe(49_900)
      expect((await wholesaleSource.productFor(id))?.variants[0]?.priceMinor).toBe(34_900)
    })

    it('carries the text of the language this channel was pointed at', async () => {
      const product = await catalog.create({
        legacyId: 'p-1',
        texts: [
          { language: 'uk', title: 'Крем для кучерів', description: 'Опис' },
          { language: 'en', title: 'Curl cream' },
        ],
      })
      await pricing.set({
        variantId: product.variants[0]?.id ?? '',
        priceListCode: 'retail',
        amountMinor: 49_900,
      })
      await catalog.setStatus(product.id, 'published')

      const english = new CatalogChannelSource(db, { language: 'en' })
      expect((await source.productFor(product.id))?.title).toBe('Крем для кучерів')
      expect((await source.productFor(product.id))?.description).toBe('Опис')
      expect((await english.productFor(product.id))?.title).toBe('Curl cream')
    })

    it('withholds text in a language the tenant does not publish', async () => {
      const product = await catalog.create({
        legacyId: 'p-1',
        texts: [
          { language: 'ru', title: 'Крем для кудрей', description: 'Описание' },
          { language: 'uk', title: 'Крем для кучерів' },
        ],
      })
      await pricing.set({
        variantId: product.variants[0]?.id ?? '',
        priceListCode: 'retail',
        amountMinor: 49_900,
      })
      await catalog.setStatus(product.id, 'published')

      const projected = await source.productFor(product.id)
      expect(projected?.title).toBe('Крем для кучерів')
      // The Russian description is kept, but it is not the Ukrainian one and
      // must not stand in for it.
      expect(projected?.description).toBeUndefined()
    })

    it('falls back to the publishing language rather than to whatever exists', async () => {
      const product = await catalog.create({
        legacyId: 'p-2',
        texts: [
          { language: 'ru', title: 'Маска' },
          { language: 'uk', title: 'Маска українською' },
        ],
      })
      await pricing.set({
        variantId: product.variants[0]?.id ?? '',
        priceListCode: 'retail',
        amountMinor: 49_900,
      })
      await catalog.setStatus(product.id, 'published')

      const english = new CatalogChannelSource(db, { language: 'en' })
      expect((await english.productFor(product.id))?.title).toBe('Маска українською')
    })

    it('carries brand, categories, attributes and images in order', async () => {
      const brand = await taxonomy.createBrand({ name: 'Inebrya' })
      const care = await taxonomy.createCategory({ name: 'Догляд' })
      await attributes.define({ code: 'volume_ml', kind: 'number', unit: 'ml' })

      const product = await catalog.create({
        legacyId: 'p-1',
        brandId: brand.id,
        primaryCategoryId: care.id,
        texts: [{ language: 'uk', title: 'Крем' }],
      })
      const variantId = product.variants[0]?.id ?? ''
      await attributes.set(variantId, 'volume_ml', 250)
      await images.add({
        productId: product.id,
        url: 'https://example.com/b.jpg',
        origin: 'own_photography',
      })
      await images.add({
        productId: product.id,
        url: 'https://example.com/a.jpg',
        origin: 'manufacturer',
        alt: 'Банка',
      })
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })
      await catalog.setStatus(product.id, 'published')

      const projected = await source.productFor(product.id)
      expect(projected).toMatchObject({
        brand: 'Inebrya',
        categories: ['Догляд'],
        attributes: { volume_ml: 250 },
      })
      expect(projected?.media).toEqual([
        { url: 'https://example.com/b.jpg', position: 0 },
        { url: 'https://example.com/a.jpg', alt: 'Банка', position: 1 },
      ])
    })

    it('maps a variant back to its product for a channel that only knows the variant', async () => {
      const id = await publish({ legacyId: 'p-1', sku: 'CC-250', retailMinor: 49_900 })
      const variant = await catalog.findVariantBySku('CC-250')

      expect(await source.productIdForVariant(variant?.id ?? '')).toBe(id)
      expect(await source.productIdForVariant('not-a-variant')).toBeNull()
    })
  })
})
