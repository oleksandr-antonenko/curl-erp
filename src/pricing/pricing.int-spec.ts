import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Catalog } from '../catalog/products.js'
import { Taxonomy } from '../catalog/taxonomy.js'
import { ChangeFeedReader } from '../change-feed/feed.js'
import { changeEvents } from '../change-feed/schema.js'
import type { Database } from '../db/client.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { applyFactor, PriceRefusedError, Pricing, PricingError } from './pricing.js'

describe('pricing', () => {
  let fixture: TenantFixture
  let db: Database
  let pricing: Pricing
  let catalog: Catalog
  let taxonomy: Taxonomy
  let variantId: string

  beforeAll(async () => {
    fixture = await createTenantFixture(['pricing'], { migrate: true })
    db = fixture.registry.connectTo(fixture.tenant('pricing')).db
    pricing = new Pricing(db)
    catalog = new Catalog(db)
    taxonomy = new Taxonomy(db)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(sql`
      truncate table variant_price_history, variant_prices, pricing_rules, price_lists,
        customer_groups, pricing_settings, product_variants, product_texts, product_categories,
        products, brands, change_events
      restart identity cascade
    `)
    await catalog.setLanguages(['uk', 'en'], 'uk')

    await pricing.createPriceList({ code: 'retail', name: 'Роздріб', isDefault: true })
    await pricing.createPriceList({ code: 'wholesale', name: 'Опт' })
    await pricing.createPriceList({ code: 'purchase', name: 'Закупка' })
    variantId = await createVariant('CC-250', 20_000)
  })

  async function createVariant(sku: string, purchaseMinor?: number): Promise<string> {
    const product = await catalog.create({
      legacyId: sku,
      texts: [{ language: 'uk', title: 'Крем' }],
      variants: [purchaseMinor === undefined ? { sku } : { sku, plannedPurchasePriceMinor: purchaseMinor }],
    })
    return product.variants[0]?.id ?? ''
  }

  describe('a price is a number, never an offset', () => {
    it('stores 349.00 as 34900', async () => {
      const price = await pricing.set({
        variantId,
        priceListCode: 'wholesale',
        amountMinor: 34_900,
      })
      expect(price.amountMinor).toBe(34_900)
      expect(await pricing.amountOfByCode(variantId, 'wholesale')).toBe(34_900)
    })

    it('leaves a derived price alone when its basis moves', async () => {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })
      await pricing.set({
        variantId,
        priceListCode: 'wholesale',
        percentageOf: { priceListCode: 'retail', basisPoints: 7_000 },
      })
      expect(await pricing.amountOfByCode(variantId, 'wholesale')).toBe(34_930)

      await pricing.set({
        variantId,
        priceListCode: 'retail',
        amountMinor: 55_000,
        overrideReason: 'Нова ціна постачальника',
      })

      expect(await pricing.amountOfByCode(variantId, 'wholesale')).toBe(34_930)
    })

    it('rounds a percentage to the kopeck rather than to a float', async () => {
      expect(applyFactor(49_900, 7_000)).toBe(34_930)
      expect(applyFactor(3_333, 15_000)).toBe(5_000)
      expect(applyFactor(1, 15_000)).toBe(2)
      expect(Number.isInteger(applyFactor(12_345, 13_333))).toBe(true)
    })
  })

  describe('which list a customer is quoted from', () => {
    beforeEach(async () => {
      await pricing.defineGroup({ code: 'wholesale', name: 'Перукарі', priceListCode: 'wholesale' })
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })
    })

    it('quotes a wholesale customer the wholesale price', async () => {
      await pricing.set({ variantId, priceListCode: 'wholesale', amountMinor: 34_900 })

      expect(await pricing.quote(variantId, 'wholesale')).toEqual({
        amountMinor: 34_900,
        priceListCode: 'wholesale',
        fellBack: false,
      })
    })

    it('quotes a visitor in no group from the default list', async () => {
      expect(await pricing.quote(variantId, null)).toEqual({
        amountMinor: 49_900,
        priceListCode: 'retail',
        fellBack: false,
      })
    })

    it('says plainly when a group had no price of its own', async () => {
      expect(await pricing.quote(variantId, 'wholesale')).toEqual({
        amountMinor: 49_900,
        priceListCode: 'retail',
        fellBack: true,
      })
    })

    it('answers nothing rather than a guess when no list has a price', async () => {
      const bare = await createVariant('CC-500')
      expect(await pricing.quote(bare, 'wholesale')).toBeNull()
    })
  })

  describe('the three ways a price is arrived at', () => {
    it('takes the stated amount when an import supplies both', async () => {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })

      const price = await pricing.set({
        variantId,
        priceListCode: 'wholesale',
        amountMinor: 32_000,
        percentageOf: { priceListCode: 'retail', basisPoints: 7_000 },
      })

      expect(price.amountMinor).toBe(32_000)
      expect(price.origin).toBe('stated')
    })

    it('computes 70% of a 499.00 retail price as 349.30', async () => {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })

      const price = await pricing.set({
        variantId,
        priceListCode: 'wholesale',
        percentageOf: { priceListCode: 'retail', basisPoints: 7_000 },
      })

      expect(price.amountMinor).toBe(34_930)
      expect(price.origin).toBe('percentage')
      expect(price.basisAmountMinor).toBe(49_900)
    })

    it('lets a brand rule fill in where nothing else does', async () => {
      const brand = await taxonomy.createBrand({ name: 'Inebrya' })
      const product = await catalog.create({
        legacyId: 'INE-1',
        brandId: brand.id,
        texts: [{ language: 'uk', title: 'Маска' }],
        variants: [{ sku: 'INE-1' }],
      })
      const ruled = product.variants[0]?.id ?? ''
      await pricing.set({ variantId: ruled, priceListCode: 'retail', amountMinor: 100_000 })

      // Wholesale is the supplier's list price; purchase is that less 30%.
      await pricing.defineRule({
        scope: 'brand',
        brandId: brand.id,
        targetPriceListCode: 'wholesale',
        basisPriceListCode: 'retail',
        factorBasisPoints: 6_000,
      })
      await pricing.defineRule({
        scope: 'brand',
        brandId: brand.id,
        targetPriceListCode: 'purchase',
        basisPriceListCode: 'wholesale',
        factorBasisPoints: 7_000,
      })

      const wholesale = await pricing.set({
        variantId: ruled,
        priceListCode: 'wholesale',
        useRule: true,
      })
      const purchase = await pricing.set({
        variantId: ruled,
        priceListCode: 'purchase',
        useRule: true,
      })

      expect(wholesale).toMatchObject({ amountMinor: 60_000, origin: 'rule' })
      expect(purchase).toMatchObject({ amountMinor: 42_000, origin: 'rule' })
    })

    it('refuses a price it has no way to work out', async () => {
      await expect(pricing.set({ variantId, priceListCode: 'wholesale' })).rejects.toThrow(PricingError)
    })
  })

  describe('explaining a price to whoever has to defend it', () => {
    it('shows the amount, the method, the percentage and the price it used', async () => {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })
      await pricing.set({
        variantId,
        priceListCode: 'wholesale',
        percentageOf: { priceListCode: 'retail', basisPoints: 7_000 },
      })

      expect(await pricing.explain(variantId, 'wholesale')).toEqual({
        amountMinor: 34_930,
        origin: 'percentage',
        factorPercent: 70,
        basisPriceList: 'retail',
        basisAmountMinor: 49_900,
        basisHasChanged: false,
      })
    })

    it('marks the basis as since changed instead of quietly recomputing', async () => {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })
      await pricing.set({
        variantId,
        priceListCode: 'wholesale',
        percentageOf: { priceListCode: 'retail', basisPoints: 7_000 },
      })
      await pricing.set({
        variantId,
        priceListCode: 'retail',
        amountMinor: 55_000,
        overrideReason: 'Нова ціна постачальника',
      })

      const explained = await pricing.explain(variantId, 'wholesale')
      expect(explained).toMatchObject({
        amountMinor: 34_930,
        basisAmountMinor: 49_900,
        basisHasChanged: true,
      })
    })

    it('explains a stated price as stated, with nothing derived', async () => {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })
      expect(await pricing.explain(variantId, 'retail')).toEqual({
        amountMinor: 49_900,
        origin: 'stated',
      })
    })
  })

  describe('guards against an implausible price', () => {
    beforeEach(async () => {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })
      await pricing.configure({ minimumAmountMinor: 100 })
    })

    it('refuses a wholesale price at or below what the goods cost, naming both', async () => {
      const refusal = await pricing
        .set({ variantId, priceListCode: 'wholesale', amountMinor: 20_000 })
        .catch((error: unknown) => error)

      expect(refusal).toBeInstanceOf(PriceRefusedError)
      expect(refusal).toMatchObject({
        reason: 'at_or_below_purchase',
        detail: { amountMinor: 20_000, purchaseMinor: 20_000 },
      })
      expect(await pricing.amountOfByCode(variantId, 'wholesale')).toBeNull()
    })

    it('refuses a wholesale price at or above retail', async () => {
      await expect(
        pricing.set({ variantId, priceListCode: 'wholesale', amountMinor: 49_900 }),
      ).rejects.toMatchObject({ reason: 'at_or_above_retail' })
    })

    it('refuses a price under the configured floor', async () => {
      await expect(
        pricing.set({ variantId, priceListCode: 'wholesale', amountMinor: 50 }),
      ).rejects.toMatchObject({ reason: 'below_minimum' })
    })

    it('refuses a price arriving ten times smaller than the current one', async () => {
      // A cheap item, so the slipped decimal is still above cost and the jump
      // is the only thing wrong with it.
      const cheap = await createVariant('CC-50', 300)
      await pricing.set({ variantId: cheap, priceListCode: 'retail', amountMinor: 49_900 })
      await pricing.set({ variantId: cheap, priceListCode: 'wholesale', amountMinor: 34_900 })

      const refusal = await pricing
        .set({ variantId: cheap, priceListCode: 'wholesale', amountMinor: 3_490 })
        .catch((error: unknown) => error)

      expect(refusal).toMatchObject({ reason: 'jump_too_large', detail: { from: 34_900, to: 3_490 } })
      expect(await pricing.amountOfByCode(cheap, 'wholesale')).toBe(34_900)
    })

    it('allows a change inside the threshold', async () => {
      await pricing.set({ variantId, priceListCode: 'wholesale', amountMinor: 34_900 })
      const price = await pricing.set({
        variantId,
        priceListCode: 'wholesale',
        amountMinor: 38_000,
      })
      expect(price.amountMinor).toBe(38_000)
    })

    it('applies a refused change when someone confirms it, and records who', async () => {
      const price = await pricing.set({
        variantId,
        priceListCode: 'wholesale',
        amountMinor: 15_000,
        actor: 'staff-anna',
        overrideReason: 'Розпродаж залишків, погоджено з власником',
      })

      expect(price.amountMinor).toBe(15_000)
      const inForce = await pricing.priceAt(variantId, 'wholesale', new Date())
      expect(inForce).toMatchObject({
        amountMinor: 15_000,
        actorId: 'staff-anna',
        overrideReason: 'Розпродаж залишків, погоджено з власником',
      })
    })

    it('refuses an override with no reason, rather than treating it as one', async () => {
      await expect(
        pricing.set({
          variantId,
          priceListCode: 'wholesale',
          amountMinor: 15_000,
          overrideReason: '   ',
        }),
      ).rejects.toThrow(/needs a reason/)
      expect(await pricing.amountOfByCode(variantId, 'wholesale')).toBeNull()
    })

    it('leaves the default list out of the wholesale comparisons', async () => {
      const price = await pricing.set({
        variantId,
        priceListCode: 'retail',
        amountMinor: 60_000,
        overrideReason: 'Підвищення цін постачальника',
      })
      expect(price.amountMinor).toBe(60_000)
    })
  })

  describe('margin before anything has been received', () => {
    it('labels it expected, and says what it was computed from', async () => {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })

      expect(await pricing.expectedMargin(variantId, 'retail')).toEqual({
        basis: 'planned_purchase_price',
        expected: true,
        priceMinor: 49_900,
        purchaseMinor: 20_000,
        marginMinor: 29_900,
        marginBasisPoints: 5_992,
      })
    })

    it('answers nothing when there is no purchase price to compare against', async () => {
      const unpriced = await createVariant('CC-999')
      await pricing.set({ variantId: unpriced, priceListCode: 'retail', amountMinor: 49_900 })

      expect(await pricing.expectedMargin(unpriced, 'retail')).toBeNull()
    })

    it('answers nothing when the variant has no price in that list', async () => {
      expect(await pricing.expectedMargin(variantId, 'wholesale')).toBeNull()
    })
  })

  describe('a price change reaches the channels', () => {
    it('records one event naming the variant and the list', async () => {
      await db.delete(changeEvents)
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })

      const events = await new ChangeFeedReader(db).read(0)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        entityType: 'price',
        entityId: `${variantId}:retail`,
        kind: 'updated',
      })
    })
  })

  describe('what the price was last month', () => {
    it('answers with the price then in force and who set it', async () => {
      await pricing.set({
        variantId,
        priceListCode: 'retail',
        amountMinor: 49_900,
        actor: 'staff-anna',
      })
      await db.execute(sql`update variant_price_history set valid_from = now() - interval '30 days'`)
      await pricing.set({
        variantId,
        priceListCode: 'retail',
        amountMinor: 55_000,
        actor: 'staff-borys',
        overrideReason: 'Нова ціна постачальника',
      })

      const lastMonth = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      expect(await pricing.priceAt(variantId, 'retail', lastMonth)).toMatchObject({
        amountMinor: 49_900,
        actorId: 'staff-anna',
      })
      expect(await pricing.priceAt(variantId, 'retail', new Date())).toMatchObject({
        amountMinor: 55_000,
        actorId: 'staff-borys',
      })
    })

    it('answers nothing for a moment before the first price', async () => {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })
      const before = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      expect(await pricing.priceAt(variantId, 'retail', before)).toBeNull()
    })

    it('keeps every change rather than overwriting the record', async () => {
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 49_900 })
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 51_000 })
      await pricing.set({ variantId, priceListCode: 'retail', amountMinor: 52_000 })

      const rows = await db.execute<{ count: string }>(
        sql`select count(*)::text as count from variant_price_history where variant_id = ${variantId}`,
      )
      expect(rows.rows[0]?.count).toBe('3')
    })
  })
})
