import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Catalog } from '../catalog/products.js'
import { Taxonomy } from '../catalog/taxonomy.js'
import type { Database } from '../db/client.js'
import { Pricing } from '../pricing/pricing.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { ProposalNotApplicableError } from './errors.js'
import { FakeLegacySource, legacyProduct } from './fake-source.js'
import { CatalogImport, effectiveAmount } from './import.js'

describe('importing a catalog off a previous system', () => {
  let fixture: TenantFixture
  let db: Database
  let catalog: Catalog
  let pricing: Pricing
  let source: FakeLegacySource
  let importer: CatalogImport

  beforeAll(async () => {
    fixture = await createTenantFixture(['import'], { migrate: true })
    db = fixture.registry.connectTo(fixture.tenant('import')).db
    catalog = new Catalog(db)
    pricing = new Pricing(db)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(sql`
      truncate table catalog_imports, variant_price_history, variant_prices, pricing_rules,
        price_lists, customer_groups, pricing_settings, product_images, variant_attributes,
        variant_group_restrictions, product_categories, product_texts, product_variants,
        products, attribute_definitions, categories, brands, catalog_settings, change_events
      restart identity cascade
    `)
    await catalog.setLanguages(['uk', 'en'], 'uk')
    await pricing.createPriceList({ code: 'retail', name: 'Роздріб', isDefault: true })
    await pricing.createPriceList({ code: 'wholesale', name: 'Опт' })
    await pricing.defineGroup({ code: 'professional', name: 'Перукарі', priceListCode: 'wholesale' })

    source = new FakeLegacySource()
    importer = new CatalogImport(db, source)
  })

  describe('a proposal changes nothing', () => {
    it('describes what would happen and leaves the catalog alone', async () => {
      source.replace([legacyProduct({ legacyId: '130460' })])

      const { proposal } = await importer.propose()

      expect(proposal.counts).toMatchObject({ create: 1, update: 0 })
      expect(await catalog.findByLegacyId('130460')).toBeNull()
    })

    it('shows what a change would replace', async () => {
      source.replace([legacyProduct({ legacyId: '130460' })])
      const first = await importer.propose()
      await importer.apply(first.id)

      source.replace([
        legacyProduct({
          legacyId: '130460',
          texts: [{ language: 'uk', title: 'Крем для кучерів' }],
        }),
      ])
      const { proposal } = await importer.propose()

      const product = proposal.products[0]
      expect(product?.action).toBe('update')
      expect(product?.changes).toMatchObject({
        'title.uk': { was: 'Крем', becomes: 'Крем для кучерів' },
      })
    })

    it('refuses to apply the same proposal twice', async () => {
      source.replace([legacyProduct({ legacyId: '130460' })])
      const { id } = await importer.propose()
      await importer.apply(id)

      await expect(importer.apply(id)).rejects.toThrow(ProposalNotApplicableError)
      await expect(importer.apply(id)).rejects.toThrow(/already applied/)
    })
  })

  describe('every source record is accounted for', () => {
    it('reconciles the three states with the number of records', async () => {
      source.replace([
        legacyProduct({ legacyId: 'a' }),
        legacyProduct({ legacyId: 'b' }),
        legacyProduct({ legacyId: 'c', texts: [] }),
        legacyProduct({ legacyId: 'd', active: false }),
      ])

      const { id } = await importer.propose()
      const report = await importer.apply(id)

      expect(report.sourceRecords).toBe(4)
      expect(report.imported + report.skipped + report.failed).toBe(4)
      expect(report.imported).toBe(2)
      expect(report.skipped).toBe(2)
    })

    it('names a record it could not interpret, and imports the rest', async () => {
      source.replace([
        legacyProduct({ legacyId: 'good' }),
        legacyProduct({ legacyId: 'nameless', texts: [] }),
      ])

      const { id } = await importer.propose()
      const report = await importer.apply(id)

      expect(report.refusals).toContainEqual({
        legacyId: 'nameless',
        reason: 'no title in any language',
      })
      expect(await catalog.findByLegacyId('good')).not.toBeNull()
    })
  })

  describe('previous identifiers are preserved', () => {
    it('matches and updates on a second run instead of duplicating', async () => {
      source.replace([legacyProduct({ legacyId: '130460' })])
      await importer.apply((await importer.propose()).id)
      const first = await catalog.findByLegacyId('130460')

      source.replace([legacyProduct({ legacyId: '130460', texts: [{ language: 'uk', title: 'Оновлений' }] })])
      await importer.apply((await importer.propose()).id)

      const second = await catalog.findByLegacyId('130460')
      expect(second?.id).toBe(first?.id)
      const all = await db.execute<{ count: string }>(sql`select count(*)::text as count from products`)
      expect(all.rows[0]?.count).toBe('1')
    })
  })

  describe('wholesale prices held as a reduction', () => {
    it('stores the amount actually charged', async () => {
      source.replace([
        legacyProduct({
          legacyId: '130460',
          retailMinor: 49_900,
          prices: [{ group: 'hairdresser', amountMinor: null, reductionMinor: 15_000 }],
        }),
      ])

      await importer.apply((await importer.propose()).id)

      const variant = await catalog.findVariantBySku('130460')
      expect(await pricing.amountOfByCode(variant?.id ?? '', 'wholesale')).toBe(34_900)
    })

    it('leaves the imported price alone when retail is edited afterwards', async () => {
      source.replace([
        legacyProduct({
          legacyId: '130460',
          retailMinor: 49_900,
          prices: [{ group: 'hairdresser', amountMinor: null, reductionMinor: 15_000 }],
        }),
      ])
      await importer.apply((await importer.propose()).id)
      const variant = await catalog.findVariantBySku('130460')

      await pricing.set({
        variantId: variant?.id ?? '',
        priceListCode: 'retail',
        amountMinor: 60_000,
        overrideReason: 'Підвищення цін',
      })

      expect(await pricing.amountOfByCode(variant?.id ?? '', 'wholesale')).toBe(34_900)
    })

    it('takes a stated amount as it stands', async () => {
      source.replace([
        legacyProduct({
          legacyId: '130460',
          prices: [{ group: 'hairdresser', amountMinor: 32_000, reductionMinor: null }],
        }),
      ])

      const { proposal } = await importer.propose()
      const wholesale = proposal.products[0]?.prices.find((p) => p.priceListCode === 'wholesale')
      expect(wholesale).toMatchObject({ amountMinor: 32_000, derivedFrom: 'stated' })
    })

    it('shows its arithmetic in the proposal', async () => {
      source.replace([
        legacyProduct({
          legacyId: '130460',
          retailMinor: 49_900,
          prices: [{ group: 'hairdresser', amountMinor: null, reductionMinor: 15_000 }],
        }),
      ])

      const { proposal } = await importer.propose()
      expect(proposal.products[0]?.prices).toContainEqual({
        priceListCode: 'wholesale',
        amountMinor: 34_900,
        derivedFrom: 'retail_less_reduction',
        reductionMinor: 15_000,
        retailMinor: 49_900,
      })
    })

    it('refuses to apply once retail has moved under the proposal', async () => {
      source.replace([
        legacyProduct({
          legacyId: '130460',
          retailMinor: 49_900,
          prices: [{ group: 'hairdresser', amountMinor: null, reductionMinor: 15_000 }],
        }),
      ])
      const { id } = await importer.propose()

      source.replace([
        legacyProduct({
          legacyId: '130460',
          retailMinor: 55_000,
          prices: [{ group: 'hairdresser', amountMinor: null, reductionMinor: 15_000 }],
        }),
      ])

      await expect(importer.apply(id)).rejects.toThrow(/changed since this proposal/)
    })

    it('works the amount out the same way in isolation', () => {
      expect(effectiveAmount({ group: 'g', amountMinor: 32_000, reductionMinor: null }, 49_900)).toBe(32_000)
      expect(effectiveAmount({ group: 'g', amountMinor: null, reductionMinor: 15_000 }, 49_900)).toBe(34_900)
      expect(effectiveAmount({ group: 'g', amountMinor: null, reductionMinor: 15_000 }, null)).toBeNull()
      // A reduction larger than the price is not a negative price.
      expect(effectiveAmount({ group: 'g', amountMinor: null, reductionMinor: 60_000 }, 49_900)).toBeNull()
    })
  })

  describe('checking its own work', () => {
    it('compares every price and reports that they match', async () => {
      source.replace([
        legacyProduct({
          legacyId: 'a',
          prices: [{ group: 'hairdresser', amountMinor: null, reductionMinor: 15_000 }],
        }),
        legacyProduct({
          legacyId: 'b',
          prices: [{ group: 'hairdresser', amountMinor: 30_000, reductionMinor: null }],
        }),
      ])

      const report = await importer.apply((await importer.propose()).id)

      expect(report.pricesCompared).toBe(2)
      expect(report.differences).toEqual([])
      expect(report.needsAttention).toBeNull()
    })

    it('names a price that has moved since the import', async () => {
      source.replace([
        legacyProduct({
          legacyId: 'a',
          prices: [{ group: 'hairdresser', amountMinor: 30_000, reductionMinor: null }],
        }),
      ])
      await importer.apply((await importer.propose()).id)

      // Someone edits the price the import set. The source still says 300.00.
      const variant = await catalog.findVariantBySku('a')
      await pricing.set({
        variantId: variant?.id ?? '',
        priceListCode: 'wholesale',
        amountMinor: 31_000,
      })

      expect(await importer.verify()).toEqual([
        {
          legacyId: 'a',
          priceListCode: 'wholesale',
          sourceMinor: 30_000,
          importedMinor: 31_000,
          differenceMinor: 1_000,
        },
      ])
    })

    it('marks a run as needing attention when a price did not arrive', async () => {
      // Two source records claiming one SKU: the second cannot be created, so
      // its price is never stored and the reconciliation is what notices.
      source.replace([
        legacyProduct({
          legacyId: 'a',
          sku: 'SHARED',
          prices: [{ group: 'hairdresser', amountMinor: 30_000, reductionMinor: null }],
        }),
        legacyProduct({
          legacyId: 'b',
          sku: 'SHARED',
          prices: [{ group: 'hairdresser', amountMinor: 45_000, reductionMinor: null }],
        }),
      ])

      const report = await importer.apply((await importer.propose()).id)

      expect(report.failed).toBe(1)
      expect(report.needsAttention).toMatch(/quoted differently/)
      expect(report.differences).toContainEqual(
        expect.objectContaining({ legacyId: 'b', sourceMinor: 45_000 }),
      )
    })
  })

  describe('gaps are reported without blocking', () => {
    it('lists products a wholesale customer would pay retail for', async () => {
      source.replace([
        legacyProduct({
          legacyId: 'priced',
          prices: [{ group: 'hairdresser', amountMinor: 30_000, reductionMinor: null }],
        }),
        legacyProduct({ legacyId: 'unpriced' }),
      ])

      const report = await importer.apply((await importer.propose()).id)

      expect(report.gaps.withoutWholesalePrice).toEqual(['unpriced'])
      expect(await catalog.findByLegacyId('unpriced')).not.toBeNull()
    })

    it('lists a product with a wholesale price and no retail price', async () => {
      source.replace([
        legacyProduct({
          legacyId: 'no-retail',
          retailMinor: null,
          prices: [{ group: 'hairdresser', amountMinor: 30_000, reductionMinor: null }],
        }),
      ])

      const report = await importer.apply((await importer.propose()).id)

      expect(report.gaps.withoutRetailPrice).toEqual(['no-retail'])
      expect(report.imported).toBe(1)
    })

    it('lists wholesale at or below cost, and at or above retail', async () => {
      source.replace([
        legacyProduct({
          legacyId: 'below-cost',
          purchaseMinor: 30_000,
          prices: [{ group: 'hairdresser', amountMinor: 30_000, reductionMinor: null }],
        }),
        legacyProduct({
          legacyId: 'above-retail',
          retailMinor: 40_000,
          prices: [{ group: 'hairdresser', amountMinor: 45_000, reductionMinor: null }],
        }),
      ])

      const report = await importer.apply((await importer.propose()).id)

      expect(report.gaps.wholesaleAtOrBelowPurchase).toEqual(['below-cost'])
      expect(report.gaps.wholesaleAtOrAboveRetail).toEqual(['above-retail'])
      // Listed, not refused: these are prices the shop has been charging.
      expect(report.imported).toBe(2)
    })

    it('lists what has no purchase price, no image, and no published title', async () => {
      source.replace([
        legacyProduct({ legacyId: 'no-cost', purchaseMinor: null }),
        legacyProduct({ legacyId: 'no-image' }),
        legacyProduct({
          legacyId: 'ru-only',
          texts: [{ language: 'ru', title: 'Крем' }],
          images: [{ url: 'https://example.com/a.jpg', position: 0 }],
        }),
      ])

      const report = await importer.apply((await importer.propose()).id)

      expect(report.gaps.withoutPurchasePrice).toEqual(['no-cost'])
      expect(report.gaps.withoutImages).toEqual(['no-cost', 'no-image'])
      expect(report.gaps.withoutTitleInPublishedLanguage).toContain('ru-only')
    })
  })

  describe('text and images', () => {
    it('keeps a language the tenant does not publish', async () => {
      source.replace([
        legacyProduct({
          legacyId: 'p-1',
          texts: [
            { language: 'uk', title: 'Крем' },
            { language: 'en', title: 'Cream' },
            { language: 'ru', title: 'Крем' },
          ],
        }),
      ])

      await importer.apply((await importer.propose()).id)

      const product = await catalog.findByLegacyId('p-1')
      const stored = await catalog.get(product?.id ?? '')
      expect(stored.texts.map((text) => text.language).sort()).toEqual(['en', 'ru', 'uk'])
    })

    it('records images with their position and where they came from', async () => {
      source.replace([
        legacyProduct({
          legacyId: 'p-1',
          images: [
            { url: 'https://example.com/a.jpg', position: 0, alt: 'Банка' },
            { url: 'https://example.com/b.jpg', position: 1 },
          ],
        }),
      ])

      await importer.apply((await importer.propose()).id)

      const product = await catalog.findByLegacyId('p-1')
      const images = await new (await import('../catalog/images.js')).Images(db).of(product?.id ?? '')
      expect(images).toHaveLength(2)
      expect(images[0]).toMatchObject({ position: 0, alt: 'Банка', origin: 'imported' })
    })

    it('does not add the same image twice on a second run', async () => {
      const withImage = legacyProduct({
        legacyId: 'p-1',
        images: [{ url: 'https://example.com/a.jpg', position: 0 }],
      })
      source.replace([withImage])
      await importer.apply((await importer.propose()).id)
      source.replace([withImage])
      await importer.apply((await importer.propose()).id)

      const product = await catalog.findByLegacyId('p-1')
      const images = await new (await import('../catalog/images.js')).Images(db).of(product?.id ?? '')
      expect(images).toHaveLength(1)
    })
  })

  describe('the report survives the run', () => {
    it('reads back a past run with its counts and who ran it', async () => {
      source.replace([legacyProduct({ legacyId: 'a' }), legacyProduct({ legacyId: 'b' })])
      const { id } = await importer.propose()
      await importer.apply(id)

      const history = await importer.history()
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({
        state: 'applied',
        source: 'previous shop',
        sourceRecords: 2,
        imported: 2,
      })
      expect(history[0]?.appliedAt).toBeInstanceOf(Date)
    })

    it('keeps each run separate, newest first', async () => {
      source.replace([legacyProduct({ legacyId: 'a' })])
      await importer.apply((await importer.propose()).id)
      source.replace([legacyProduct({ legacyId: 'a' }), legacyProduct({ legacyId: 'b' })])
      await importer.apply((await importer.propose()).id)

      const history = await importer.history()
      expect(history.map((run) => run.sourceRecords)).toEqual([2, 1])
    })
  })

  describe('withdrawing what the source no longer offers', () => {
    it('takes down a product that has gone inactive', async () => {
      source.replace([legacyProduct({ legacyId: 'a' })])
      await importer.apply((await importer.propose()).id)

      source.replace([legacyProduct({ legacyId: 'a', active: false })])
      const { proposal, id } = await importer.propose()
      expect(proposal.counts.withdraw).toBe(1)

      await importer.apply(id)
      const product = await catalog.findByLegacyId('a')
      expect((await catalog.get(product?.id ?? '')).status).toBe('withdrawn')
    })
  })

  describe('brands', () => {
    it('creates one brand however many products carry it', async () => {
      source.replace([
        legacyProduct({ legacyId: 'a', brand: 'Inebrya' }),
        legacyProduct({ legacyId: 'b', brand: 'Inebrya' }),
        legacyProduct({ legacyId: 'c', brand: 'Inebrya' }),
        legacyProduct({ legacyId: 'd', brand: 'Kaaral' }),
      ])

      const report = await importer.apply((await importer.propose()).id)

      // The first run against the real catalog lost 385 of 557 products here:
      // a brand was created per product, and every product after the first of
      // its brand failed on the name already being taken.
      expect(report.imported).toBe(4)
      expect(report.refusals).toEqual([])
      const brands = await new Taxonomy(db).listBrands()
      expect(brands.map((brand) => brand.name).sort()).toEqual(['Inebrya', 'Kaaral'])
    })

    it('reuses the brand on a second run rather than failing on it', async () => {
      const products = [
        legacyProduct({ legacyId: 'a', brand: 'Inebrya' }),
        legacyProduct({ legacyId: 'b', brand: 'Inebrya' }),
      ]
      source.replace(products)
      await importer.apply((await importer.propose()).id)

      source.replace(products)
      const second = await new CatalogImport(db, source).apply(
        (await new CatalogImport(db, source).propose()).id,
      )

      expect(second.refusals).toEqual([])
      expect(await new Taxonomy(db).listBrands()).toHaveLength(1)
    })
  })

  describe('categories', () => {
    it('rebuilds the same tree on a second run instead of refusing', async () => {
      source.setCategories([
        { legacyId: 'c-1', name: 'Догляд', parentLegacyId: null },
        { legacyId: 'c-2', name: 'Шампуні', parentLegacyId: 'c-1' },
      ])
      source.replace([legacyProduct({ legacyId: 'p-1', primaryCategory: 'c-2' })])
      await importer.apply((await importer.propose()).id)

      source.replace([legacyProduct({ legacyId: 'p-1', primaryCategory: 'c-2' })])
      const second = await new CatalogImport(db, source).apply(
        (await new CatalogImport(db, source).propose()).id,
      )

      expect(second.refusals).toEqual([])
      expect(await new Taxonomy(db).listCategories()).toHaveLength(2)
    })

    it('rebuilds the tree and places products in it', async () => {
      source.setCategories([
        { legacyId: 'c-2', name: 'Шампуні', parentLegacyId: 'c-1' },
        { legacyId: 'c-1', name: 'Догляд', parentLegacyId: null },
      ])
      source.replace([legacyProduct({ legacyId: 'p-1', primaryCategory: 'c-2', categories: ['c-1', 'c-2'] })])

      await importer.apply((await importer.propose()).id)

      const product = await catalog.findByLegacyId('p-1')
      const stored = await catalog.get(product?.id ?? '')
      expect(stored.categoryIds).toHaveLength(2)
    })
  })
})
