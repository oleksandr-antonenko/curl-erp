import type { ChannelOrder, ChannelProductInput, SalesChannelAdapter } from './contract.js'

/**
 * The test primitives, passed in rather than imported.
 *
 * An adapter may be written by someone outside this repository, using a
 * different test runner. Taking `describe`, `it` and `expect` as arguments
 * keeps the suite usable by them, and keeps a test framework out of the
 * runtime dependencies of the core.
 */
export interface TestPrimitives {
  describe(name: string, body: () => void): void
  it(name: string, body: () => Promise<void> | void): void
  expect: (actual: unknown) => {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toBeGreaterThan(expected: number): void
    toContain(expected: unknown): void
  }
}

export interface ContractSuiteOptions extends TestPrimitives {
  /** A fresh adapter for each test. */
  createAdapter(): Promise<SalesChannelAdapter> | SalesChannelAdapter
}

const PRODUCT: ChannelProductInput = {
  localId: 'prod-1',
  title: 'Curl cream',
  description: 'For defined curls',
  variants: [
    {
      localId: 'var-1',
      sku: 'CC-250',
      title: '250 ml',
      priceMinor: 49900,
      currency: 'UAH',
    },
    {
      localId: 'var-2',
      sku: 'CC-500',
      title: '500 ml',
      priceMinor: 84900,
      currency: 'UAH',
    },
  ],
}

function orderFor(externalVariantId: string, placedAt: Date): ChannelOrder {
  return {
    externalId: `order-${placedAt.getTime()}`,
    placedAt,
    currency: 'UAH',
    totalMinor: 49900,
    lines: [{ externalVariantId, quantity: 1, unitPriceMinor: 49900 }],
    customer: { externalId: 'cust-1', email: 'buyer@example.com' },
  }
}

/**
 * What every sales-channel adapter must do.
 *
 * Run against any implementation. The properties here are the ones the core
 * relies on and cannot check for itself - above all that publishing twice
 * updates rather than duplicates, because the core retries and a shop full of
 * duplicate listings is not something a customer forgives.
 */
export function runChannelContractTests(options: ContractSuiteOptions): void {
  const { describe, it, expect, createAdapter } = options

  describe('sales channel contract', () => {
    it('declares an id and its capabilities', async () => {
      const adapter = await createAdapter()
      expect(typeof adapter.id).toBe('string')
      expect(adapter.id.length).toBeGreaterThan(0)
      expect(typeof adapter.capabilities.customerGroups).toBe('boolean')
      expect(typeof adapter.capabilities.stockLevels).toBe('boolean')
      expect(typeof adapter.capabilities.orderStatus).toBe('boolean')
    })

    it('returns an external id for the product and for every variant', async () => {
      const adapter = await createAdapter()
      const result = await adapter.publishProduct(PRODUCT)

      expect(typeof result.externalId).toBe('string')
      expect(result.variants.length).toBe(PRODUCT.variants.length)
      expect(result.variants.map((variant) => variant.localId).sort()).toEqual(['var-1', 'var-2'])
      for (const variant of result.variants) {
        expect(typeof variant.externalId).toBe('string')
        expect(variant.externalId.length).toBeGreaterThan(0)
      }
    })

    it('updates rather than duplicates when told the existing id', async () => {
      const adapter = await createAdapter()
      const first = await adapter.publishProduct(PRODUCT)
      const second = await adapter.publishProduct(
        { ...PRODUCT, title: 'Curl cream, new recipe' },
        first.externalId,
      )

      expect(second.externalId).toBe(first.externalId)
      expect(second.variants.map((variant) => variant.externalId).sort()).toEqual(
        first.variants.map((variant) => variant.externalId).sort(),
      )
    })

    it('keeps variant identities stable across republishing', async () => {
      const adapter = await createAdapter()
      const first = await adapter.publishProduct(PRODUCT)
      const again = await adapter.publishProduct(PRODUCT, first.externalId)

      const idOf = (result: typeof first, localId: string): string =>
        result.variants.find((variant) => variant.localId === localId)?.externalId ?? ''
      expect(idOf(again, 'var-1')).toBe(idOf(first, 'var-1'))
    })

    it('tolerates unpublishing something that is already gone', async () => {
      const adapter = await createAdapter()
      const published = await adapter.publishProduct(PRODUCT)
      await adapter.unpublishProduct(published.externalId)
      await adapter.unpublishProduct(published.externalId)
      expect(true).toBe(true)
    })

    it('accepts stock levels for published variants', async () => {
      const adapter = await createAdapter()
      await adapter.publishProduct(PRODUCT)
      await adapter.publishStock([
        { variantLocalId: 'var-1', available: 7 },
        { variantLocalId: 'var-2', available: 0 },
      ])
      expect(true).toBe(true)
    })

    it('accepts prices for published variants', async () => {
      const adapter = await createAdapter()
      await adapter.publishProduct(PRODUCT)
      await adapter.publishPrices([{ variantLocalId: 'var-1', priceMinor: 45900, currency: 'UAH' }])
      expect(true).toBe(true)
    })

    it('returns only orders placed after the given moment, oldest first', async () => {
      const adapter = await createAdapter()
      const published = await adapter.publishProduct(PRODUCT)
      const externalVariantId = published.variants[0]?.externalId ?? 'var-1'

      const place = (adapter as unknown as { placeOrder?: (order: ChannelOrder) => void }).placeOrder
      if (place === undefined) return // adapters without a way to inject orders

      const old = new Date('2026-01-01T00:00:00Z')
      const recent = new Date('2026-06-01T00:00:00Z')
      place.call(adapter, orderFor(externalVariantId, old))
      place.call(adapter, orderFor(externalVariantId, recent))

      const since = new Date('2026-03-01T00:00:00Z')
      const orders = await adapter.fetchOrders(since)
      expect(orders.length).toBe(1)
      expect(orders[0]?.placedAt.toISOString()).toBe(recent.toISOString())
    })

    it('gives every order an external id, a moment and at least one line', async () => {
      const adapter = await createAdapter()
      const orders = await adapter.fetchOrders(new Date(0))
      for (const order of orders) {
        expect(typeof order.externalId).toBe('string')
        expect(order.placedAt instanceof Date).toBe(true)
        expect(order.lines.length).toBeGreaterThan(0)
      }
      expect(true).toBe(true)
    })

    it('accepts a status update for an order', async () => {
      const adapter = await createAdapter()
      await adapter.publishOrderStatus({
        externalOrderId: 'order-1',
        status: 'shipped',
        trackingReference: '20450000000000',
      })
      expect(true).toBe(true)
    })

    it('reports its own stock when it says it can', async () => {
      const adapter = await createAdapter()
      if (!adapter.capabilities.stockReporting) return
      if (adapter.fetchStock === undefined) {
        throw new Error('declares stockReporting but does not implement fetchStock')
      }

      await adapter.publishProduct(PRODUCT)
      await adapter.publishStock([{ variantLocalId: 'var-1', available: 3 }])
      const reported = await adapter.fetchStock()
      expect(reported.length).toBeGreaterThan(0)
    })
  })
}
