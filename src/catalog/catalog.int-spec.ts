import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeFeedReader } from '../change-feed/feed.js'
import { changeEvents } from '../change-feed/schema.js'
import type { Database } from '../db/client.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { Attributes } from './attributes.js'
import { CatalogError, DuplicateIdentifierError } from './errors.js'
import { Images } from './images.js'
import { Catalog } from './products.js'
import { Taxonomy } from './taxonomy.js'

describe('catalog', () => {
  let fixture: TenantFixture
  let db: Database
  let catalog: Catalog
  let taxonomy: Taxonomy
  let attributes: Attributes
  let images: Images

  beforeAll(async () => {
    fixture = await createTenantFixture(['catalog'], { migrate: true })
    db = fixture.registry.connectTo(fixture.tenant('catalog')).db
    catalog = new Catalog(db)
    taxonomy = new Taxonomy(db)
    attributes = new Attributes(db)
    images = new Images(db)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(sql`
      truncate table product_images, variant_attributes, variant_group_restrictions,
        product_categories, product_texts, product_variants, products,
        attribute_definitions, categories, brands, catalog_settings, change_events
      restart identity cascade
    `)
    await catalog.setLanguages(['uk', 'en'], 'uk')
  })

  const simpleProduct = (sku: string, title = 'Curl cream') => ({
    legacyId: sku,
    texts: [{ language: 'uk', title }],
    variants: [{ sku }],
  })

  describe('products and variants', () => {
    it('gives a product a variant even when none was asked for', async () => {
      const product = await catalog.create({
        legacyId: 'p-1',
        texts: [{ language: 'uk', title: 'Крем' }],
      })

      expect(product.variants).toHaveLength(1)
      expect(product.variants[0]?.sku).toBe('p-1')
      expect(product.status).toBe('draft')
    })

    it('refuses a SKU that already belongs to something', async () => {
      await catalog.create(simpleProduct('CC-250'))
      await expect(catalog.create(simpleProduct('CC-250'))).rejects.toThrow(DuplicateIdentifierError)
    })

    it('refuses a barcode that already belongs to something', async () => {
      await catalog.create({
        legacyId: 'a',
        texts: [{ language: 'uk', title: 'A' }],
        variants: [{ sku: 'A-1', barcode: '4820000000001' }],
      })
      await expect(
        catalog.create({
          legacyId: 'b',
          texts: [{ language: 'uk', title: 'B' }],
          variants: [{ sku: 'B-1', barcode: '4820000000001' }],
        }),
      ).rejects.toThrow(/barcode/)
    })

    it('keeps the identifier of the shop it came from', async () => {
      await catalog.create(simpleProduct('130460'))
      const found = await catalog.findByLegacyId('130460')
      expect(found?.legacyId).toBe('130460')
      expect(found?.variants[0]?.sku).toBe('130460')
    })

    it('moves between draft, published and withdrawn', async () => {
      const created = await catalog.create(simpleProduct('CC-250'))
      expect((await catalog.setStatus(created.id, 'published')).status).toBe('published')
      expect((await catalog.setStatus(created.id, 'withdrawn')).status).toBe('withdrawn')
    })

    it('announces a withdrawal so channels take the listing down', async () => {
      const created = await catalog.create(simpleProduct('CC-250'))
      await catalog.setStatus(created.id, 'published')
      await db.delete(changeEvents)

      await catalog.setStatus(created.id, 'withdrawn')

      const events = await new ChangeFeedReader(db).read(0)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ entityType: 'product', kind: 'deleted' })
    })

    it('records one event with the field that changed', async () => {
      const created = await catalog.create(simpleProduct('CC-250'))
      await db.delete(changeEvents)

      await catalog.setTexts(created.id, [{ language: 'uk', title: 'Крем для кучерів' }])

      const events = await new ChangeFeedReader(db).read(0)
      expect(events).toHaveLength(1)
      expect(events[0]?.changedFields).toEqual(['text.uk'])
    })
  })

  describe('text per language', () => {
    it('keeps a language it does not publish', async () => {
      const created = await catalog.create({
        legacyId: 'p-1',
        texts: [
          { language: 'uk', title: 'Крем' },
          { language: 'en', title: 'Cream' },
          { language: 'ru', title: 'Крем' },
        ],
      })

      const product = await catalog.get(created.id)
      expect(product.texts.map((text) => text.language).sort()).toEqual(['en', 'ru', 'uk'])
      expect((await catalog.languages()).published).toEqual(['uk', 'en'])
    })

    it('lists products missing a title in a published language', async () => {
      const withBoth = await catalog.create({
        legacyId: 'both',
        texts: [
          { language: 'uk', title: 'Крем' },
          { language: 'en', title: 'Cream' },
        ],
      })
      const withoutEnglish = await catalog.create({
        legacyId: 'uk-only',
        texts: [{ language: 'uk', title: 'Маска' }],
      })

      const incomplete = await catalog.incompleteIn('en')
      expect(incomplete).toContain(withoutEnglish.id)
      expect(incomplete).not.toContain(withBoth.id)
    })

    it('refuses a fallback language it does not publish', async () => {
      await expect(catalog.setLanguages(['uk', 'en'], 'ru')).rejects.toThrow(CatalogError)
    })
  })

  describe('categories', () => {
    it('holds a tree and a product in several of its nodes', async () => {
      const care = await taxonomy.createCategory({ name: 'Догляд' })
      const shampoo = await taxonomy.createCategory({ name: 'Шампуні', parentId: care.id })
      const gifts = await taxonomy.createCategory({ name: 'Подарунки' })

      const product = await catalog.create({
        legacyId: 'p-1',
        texts: [{ language: 'uk', title: 'Шампунь' }],
        primaryCategoryId: shampoo.id,
        categoryIds: [gifts.id],
      })

      const stored = await catalog.get(product.id)
      expect(stored.categoryIds).toHaveLength(2)
      expect(stored.primaryCategoryId).toBe(shampoo.id)

      const tree = await taxonomy.categoryTree()
      expect(tree.map((node) => node.name).sort()).toEqual(['Догляд', 'Подарунки'])
      expect(tree.find((node) => node.name === 'Догляд')?.children[0]?.name).toBe('Шампуні')
    })

    it('refuses to delete a category that still holds something', async () => {
      const category = await taxonomy.createCategory({ name: 'Догляд' })
      await catalog.create({
        legacyId: 'p-1',
        texts: [{ language: 'uk', title: 'Шампунь' }],
        primaryCategoryId: category.id,
      })

      await expect(taxonomy.deleteCategory(category.id)).rejects.toThrow(/still holds/)

      const child = await taxonomy.createCategory({ name: 'Дочірня', parentId: category.id })
      await expect(taxonomy.deleteCategory(category.id)).rejects.toThrow(/child/)
      expect(child.parentId).toBe(category.id)
    })
  })

  describe('brands', () => {
    it('renames without touching the products under it', async () => {
      const brand = await taxonomy.createBrand({ name: 'Inebrya' })
      const first = await catalog.create({
        legacyId: 'p-1',
        brandId: brand.id,
        texts: [{ language: 'uk', title: 'Крем' }],
      })
      const second = await catalog.create({
        legacyId: 'p-2',
        brandId: brand.id,
        texts: [{ language: 'uk', title: 'Маска' }],
      })

      const renamed = await taxonomy.renameBrand(brand.id, 'INEBRYA')
      expect(renamed.name).toBe('INEBRYA')

      const under = await taxonomy.productsOfBrand(brand.id)
      expect(under.sort()).toEqual([first.id, second.id].sort())
      expect((await catalog.get(first.id)).brandId).toBe(brand.id)
    })
  })

  describe('attributes', () => {
    it('accepts only what the declared type allows', async () => {
      await attributes.define({ code: 'volume_ml', kind: 'number', unit: 'ml' })
      await attributes.define({
        code: 'hair_type',
        kind: 'option',
        options: ['curly', 'coloured', 'fine'],
      })

      const product = await catalog.create(simpleProduct('CC-250'))
      const variantId = product.variants[0]?.id ?? ''

      await attributes.set(variantId, 'volume_ml', 250)
      await attributes.set(variantId, 'hair_type', 'curly')

      await expect(attributes.set(variantId, 'volume_ml', 'много')).rejects.toThrow(/number/)
      await expect(attributes.set(variantId, 'hair_type', 'straight')).rejects.toThrow(/not an option/)

      const stored = await attributes.of(variantId)
      expect(stored).toEqual(
        expect.arrayContaining([
          { code: 'volume_ml', kind: 'number', value: 250, unit: 'ml' },
          { code: 'hair_type', kind: 'option', value: 'curly', unit: null },
        ]),
      )
    })

    it('finds variants by an attribute value', async () => {
      await attributes.define({ code: 'volume_ml', kind: 'number', unit: 'ml' })
      const small = await catalog.create(simpleProduct('CC-250'))
      const large = await catalog.create(simpleProduct('CC-500'))

      await attributes.set(small.variants[0]?.id ?? '', 'volume_ml', 250)
      await attributes.set(large.variants[0]?.id ?? '', 'volume_ml', 500)

      expect(await attributes.variantsWith('volume_ml', 250)).toEqual([small.variants[0]?.id])
    })

    it('refuses an option list with no options', async () => {
      await expect(attributes.define({ code: 'bad', kind: 'option' })).rejects.toThrow(/no options/)
    })
  })

  describe('images', () => {
    it('refuses an image that does not say where it came from', async () => {
      const product = await catalog.create(simpleProduct('CC-250'))
      await expect(
        images.add({
          productId: product.id,
          url: 'https://example.com/a.jpg',
          origin: 'nowhere' as never,
        }),
      ).rejects.toThrow(/origin must be one of/)

      await expect(
        images.add({ productId: product.id, url: 'https://example.com/a.jpg', origin: 'other' }),
      ).rejects.toThrow(/must say where it came from/)
    })

    it('accounts for every image by origin', async () => {
      const product = await catalog.create(simpleProduct('CC-250'))
      await images.add({
        productId: product.id,
        url: 'https://example.com/a.jpg',
        origin: 'manufacturer',
      })
      await images.add({
        productId: product.id,
        url: 'https://example.com/b.jpg',
        origin: 'generated',
      })

      expect(await images.countByOrigin()).toEqual({ manufacturer: 1, generated: 1 })
      const stored = await images.of(product.id)
      expect(stored.map((image) => image.position)).toEqual([0, 1])
    })
  })

  describe('browsing the catalog', () => {
    async function stock(): Promise<{ inebrya: string; care: string }> {
      const inebrya = await taxonomy.createBrand({ name: 'Inebrya' })
      const kaaral = await taxonomy.createBrand({ name: 'Kaaral' })
      const care = await taxonomy.createCategory({ name: 'Догляд' })
      const colour = await taxonomy.createCategory({ name: 'Фарбування' })

      const cream = await catalog.create({
        legacyId: '130460',
        brandId: inebrya.id,
        primaryCategoryId: care.id,
        texts: [{ language: 'uk', title: 'Крем для кучерів' }],
        variants: [{ sku: 'CC-250', plannedPurchasePriceMinor: 20_000 }],
      })
      await catalog.setStatus(cream.id, 'published')

      const mask = await catalog.create({
        legacyId: '130461',
        brandId: inebrya.id,
        primaryCategoryId: colour.id,
        texts: [{ language: 'uk', title: 'Маска' }],
        variants: [{ sku: 'MK-500' }],
      })
      await catalog.setStatus(mask.id, 'published')

      await catalog.create({
        legacyId: '130462',
        brandId: kaaral.id,
        primaryCategoryId: care.id,
        texts: [{ language: 'uk', title: 'Шампунь' }],
        variants: [{ sku: 'SH-1000' }],
      })

      return { inebrya: inebrya.id, care: care.id }
    }

    it('lists products with the things a list shows', async () => {
      await stock()

      const page = await catalog.browse()

      expect(page.total).toBe(3)
      expect(page.rows.map((row) => row.title)).toEqual(['Крем для кучерів', 'Маска', 'Шампунь'])
      expect(page.rows[0]).toMatchObject({
        legacyId: '130460',
        status: 'published',
        brandName: 'Inebrya',
        sku: 'CC-250',
        variantCount: 1,
      })
    })

    it('carries no cost, so a listing cannot leak one', async () => {
      await stock()
      const page = await catalog.browse()

      expect(JSON.stringify(page)).not.toContain('20000')
      expect(Object.keys(page.rows[0] ?? {})).not.toContain('plannedPurchasePriceMinor')
    })

    it('filters by brand, by category and by state', async () => {
      const { inebrya, care } = await stock()

      expect((await catalog.browse({ brandId: inebrya })).total).toBe(2)
      expect((await catalog.browse({ categoryId: care })).total).toBe(2)
      expect((await catalog.browse({ status: 'draft' })).rows.map((row) => row.title)).toEqual(['Шампунь'])
      expect((await catalog.browse({ brandId: inebrya, categoryId: care })).total).toBe(1)
    })

    it('finds a product by title, by SKU and by the old shop number', async () => {
      await stock()

      expect((await catalog.browse({ search: 'кучер' })).rows[0]?.sku).toBe('CC-250')
      expect((await catalog.browse({ search: 'MK-500' })).rows[0]?.title).toBe('Маска')
      expect((await catalog.browse({ search: '130462' })).rows[0]?.title).toBe('Шампунь')
      expect((await catalog.browse({ search: 'нічого' })).total).toBe(0)
    })

    it('counts the whole result, not the page', async () => {
      await stock()

      const page = await catalog.browse({ limit: 2 })
      expect(page.rows).toHaveLength(2)
      expect(page.total).toBe(3)

      const second = await catalog.browse({ limit: 2, offset: 2 })
      expect(second.rows).toHaveLength(1)
    })

    it('lists a product with no title in this language rather than hiding it', async () => {
      await catalog.create({
        legacyId: 'uk-only',
        texts: [{ language: 'uk', title: 'Тільки українською' }],
      })

      const english = await catalog.browse({ language: 'en' })
      expect(english.total).toBe(1)
      expect(english.rows[0]).toMatchObject({ title: null, legacyId: 'uk-only' })
    })

    it('counts a product once however many variants it has', async () => {
      await catalog.create({
        legacyId: 'multi',
        texts: [{ language: 'uk', title: 'Набір' }],
        variants: [{ sku: 'A-1' }, { sku: 'A-2' }, { sku: 'A-3' }],
      })

      const page = await catalog.browse()
      expect(page.total).toBe(1)
      expect(page.rows[0]?.variantCount).toBe(3)
    })
  })

  describe('who may see a variant', () => {
    it('records the groups a variant is restricted to', async () => {
      const product = await catalog.create({
        legacyId: 'pro-1',
        texts: [{ language: 'uk', title: 'Професійна лінія' }],
        variants: [{ sku: 'PRO-1', restrictedToGroups: ['wholesale'] }],
      })

      expect(product.variants[0]?.restrictedToGroups).toEqual(['wholesale'])

      const relaxed = await catalog.setRestrictions(product.variants[0]?.id ?? '', [])
      expect(relaxed.restrictedToGroups).toEqual([])
    })
  })
})
