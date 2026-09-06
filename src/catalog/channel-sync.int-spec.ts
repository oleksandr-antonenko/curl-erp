import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MemoryChannelAdapter } from '../channels/memory-adapter.js'
import { ChannelSync } from '../channels/sync.js'
import type { Database } from '../db/client.js'
import { Pricing } from '../pricing/pricing.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { Catalog } from './products.js'
import { CatalogChannelSource } from './source.js'

/**
 * The channel layer driven by the real catalog rather than a fixture.
 *
 * The fixture proves the contract; this proves the catalog satisfies it. A
 * catalog that only ever met a hand-written stand-in is a catalog nobody has
 * checked against the thing it exists to feed.
 */
describe('a channel fed by the real catalog', () => {
  let fixture: TenantFixture
  let db: Database
  let catalog: Catalog
  let pricing: Pricing

  beforeAll(async () => {
    fixture = await createTenantFixture(['sync'], { migrate: true })
    db = fixture.registry.connectTo(fixture.tenant('sync')).db
    catalog = new Catalog(db)
    pricing = new Pricing(db)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(sql`
      truncate table variant_price_history, variant_prices, pricing_rules, price_lists,
        customer_groups, pricing_settings, product_images, variant_attributes,
        variant_group_restrictions, product_categories, product_texts, product_variants,
        products, attribute_definitions, categories, brands, catalog_settings,
        change_events, feed_consumers, channel_outbound, channel_mappings, channel_publications
      restart identity cascade
    `)
    await catalog.setLanguages(['uk', 'en'], 'uk')
    await pricing.createPriceList({ code: 'retail', name: 'Роздріб', isDefault: true })
    await pricing.createPriceList({ code: 'wholesale', name: 'Опт' })
    await pricing.defineGroup({ code: 'professional', name: 'Перукарі', priceListCode: 'wholesale' })
  })

  function syncFor(adapter: MemoryChannelAdapter, priceListCode?: string): ChannelSync {
    return new ChannelSync(db, adapter.id, {
      catalog: new CatalogChannelSource(db, {
        language: 'uk',
        ...(priceListCode === undefined ? {} : { priceListCode }),
      }),
    })
  }

  async function carry(sync: ChannelSync, adapter: MemoryChannelAdapter): Promise<void> {
    await sync.pull()
    await sync.push(adapter)
  }

  it('carries a published product to the shop with its price and text', async () => {
    const adapter = new MemoryChannelAdapter({ id: 'shop' })
    const sync = syncFor(adapter)
    await sync.register()

    const product = await catalog.create({
      legacyId: 'p-1',
      texts: [{ language: 'uk', title: 'Крем для кучерів' }],
      variants: [{ sku: 'CC-250' }],
    })
    await pricing.set({
      variantId: product.variants[0]?.id ?? '',
      priceListCode: 'retail',
      amountMinor: 49_900,
    })
    await catalog.setStatus(product.id, 'published')

    await carry(sync, adapter)

    const listings = [...adapter.listings.values()]
    expect(listings).toHaveLength(1)
    expect(listings[0]?.product).toMatchObject({
      title: 'Крем для кучерів',
      variants: [expect.objectContaining({ sku: 'CC-250', priceMinor: 49_900 })],
    })
  })

  it('takes the listing down when the product is withdrawn', async () => {
    const adapter = new MemoryChannelAdapter({ id: 'shop' })
    const sync = syncFor(adapter)
    await sync.register()

    const product = await catalog.create({
      legacyId: 'p-1',
      texts: [{ language: 'uk', title: 'Крем' }],
      variants: [{ sku: 'CC-250' }],
    })
    await pricing.set({
      variantId: product.variants[0]?.id ?? '',
      priceListCode: 'retail',
      amountMinor: 49_900,
    })
    await catalog.setStatus(product.id, 'published')
    await carry(sync, adapter)
    expect(adapter.listings.size).toBe(1)

    await catalog.setStatus(product.id, 'withdrawn')
    await carry(sync, adapter)

    expect(adapter.listings.size).toBe(0)
  })

  it('sends a price change on to the shop', async () => {
    const adapter = new MemoryChannelAdapter({ id: 'shop' })
    const sync = syncFor(adapter)
    await sync.register()

    const product = await catalog.create({
      legacyId: 'p-1',
      texts: [{ language: 'uk', title: 'Крем' }],
      variants: [{ sku: 'CC-250' }],
    })
    const variantId = product.variants[0]?.id ?? ''
    await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })
    await catalog.setStatus(product.id, 'published')
    await carry(sync, adapter)

    await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 52_000 })
    await carry(sync, adapter)

    const listing = [...adapter.listings.values()][0]
    expect(listing?.product.variants[0]?.priceMinor).toBe(52_000)
  })

  describe('a variant priced only for professionals', () => {
    async function professionalLine(): Promise<string> {
      const product = await catalog.create({
        legacyId: 'pro-1',
        texts: [{ language: 'uk', title: 'Фарба 100 мл' }],
        variants: [{ sku: 'PRO-1' }],
      })
      await pricing.set({
        variantId: product.variants[0]?.id ?? '',
        priceListCode: 'wholesale',
        amountMinor: 34_900,
      })
      await catalog.setStatus(product.id, 'published')
      return product.id
    }

    it('is absent from a retail visitor listing entirely', async () => {
      const adapter = new MemoryChannelAdapter({ id: 'shop', capabilities: { customerGroups: true } })
      const sync = syncFor(adapter)
      await sync.register()
      await professionalLine()

      await carry(sync, adapter)

      const listing = [...adapter.listings.values()][0]
      expect(listing?.product.variants).toEqual([])
      expect(listing?.product.restrictedToGroups).toEqual(['professional'])
    })

    it('appears with its wholesale price to a wholesale audience', async () => {
      const adapter = new MemoryChannelAdapter({ id: 'b2b', capabilities: { customerGroups: true } })
      const sync = syncFor(adapter, 'wholesale')
      await sync.register()
      await professionalLine()

      await carry(sync, adapter)

      const listing = [...adapter.listings.values()][0]
      expect(listing?.product.variants[0]).toMatchObject({ sku: 'PRO-1', priceMinor: 34_900 })
    })

    it('never reaches a marketplace that cannot tell customers apart', async () => {
      const adapter = new MemoryChannelAdapter({
        id: 'marketplace',
        capabilities: { customerGroups: false },
      })
      const sync = syncFor(adapter)
      await sync.register()
      await professionalLine()

      await carry(sync, adapter)

      expect(adapter.listings.size).toBe(0)
    })
  })

  it('keeps text in a language the tenant does not publish off the channel', async () => {
    const adapter = new MemoryChannelAdapter({ id: 'shop' })
    const sync = syncFor(adapter)
    await sync.register()

    const product = await catalog.create({
      legacyId: 'p-1',
      texts: [{ language: 'ru', title: 'Крем для кудрей' }],
      variants: [{ sku: 'CC-250' }],
    })
    await pricing.set({
      variantId: product.variants[0]?.id ?? '',
      priceListCode: 'retail',
      amountMinor: 49_900,
    })
    await catalog.setStatus(product.id, 'published')

    await carry(sync, adapter)

    const listing = [...adapter.listings.values()][0]
    expect(listing?.product.title).not.toBe('Крем для кудрей')
    // Kept in the catalog, simply not shown.
    expect((await catalog.get(product.id)).texts.map((text) => text.language)).toEqual(['ru'])
  })
})
