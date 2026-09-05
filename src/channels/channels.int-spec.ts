import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeFeedReader } from '../change-feed/feed.js'
import { recordChange } from '../change-feed/record.js'
import { changeEvents } from '../change-feed/schema.js'
import type { Database } from '../db/client.js'
import { createTenantFixture, InMemoryStock, type TenantFixture } from '../testing/index.js'
import type { ChannelOrder, ChannelProductInput } from './contract.js'
import { ChannelCustomers } from './customers.js'
import { ChannelMappings } from './mappings.js'
import { MemoryChannelAdapter } from './memory-adapter.js'
import { ChannelOrders } from './orders.js'
import { ChannelOutbound } from './outbound.js'
import { ChannelPayments } from './payments.js'
import { ChannelPublications, decidePublication } from './publications.js'
import { ChannelNotAvailableError, ChannelRegistry } from './registry.js'
import {
  channelDrift,
  channelInboxOrders,
  channelMappings,
  channelOutbound,
  channelPayments,
  channelPublications,
  channelState,
  counterparties,
  counterpartyIdentities,
} from './schema.js'
import { ChannelStock } from './stock.js'
import { ChannelSync } from './sync.js'

const CHANNEL = 'storefront'

const PRODUCT: ChannelProductInput = {
  localId: 'prod-1',
  title: 'Curl cream',
  variants: [
    { localId: 'var-1', sku: 'CC-250', title: '250 ml', priceMinor: 49900, currency: 'UAH' },
    { localId: 'var-2', sku: 'CC-500', title: '500 ml', priceMinor: 84900, currency: 'UAH' },
  ],
}

describe('sales channels', () => {
  let fixture: TenantFixture
  let db: Database

  beforeAll(async () => {
    fixture = await createTenantFixture(['channels'], { migrate: true })
    db = fixture.registry.connectTo(fixture.tenant('channels')).db
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.delete(channelPayments)
    await db.delete(channelInboxOrders)
    await db.delete(channelOutbound)
    await db.delete(channelDrift)
    await db.delete(channelPublications)
    await db.delete(channelMappings)
    await db.delete(channelState)
    await db.delete(counterpartyIdentities)
    await db.delete(counterparties)
    await db.delete(changeEvents)
  })

  describe('registry', () => {
    it('works with no channels configured at all', async () => {
      const registry = new ChannelRegistry()
      expect(registry.size).toBe(0)
      expect(registry.all()).toEqual([])
      expect(() => registry.get('storefront')).toThrow(ChannelNotAvailableError)
    })

    it('reports a configured adapter that is not installed, and keeps going', async () => {
      const registry = new ChannelRegistry()
      const statuses = await registry.load(
        [
          { id: 'missing', resolve: '@curl-erp/channel-not-installed' },
          { id: 'present', resolve: 'memory' },
        ],
        async (specifier) =>
          specifier === 'memory'
            ? { createChannelAdapter: () => new MemoryChannelAdapter({ id: 'present' }) }
            : Promise.reject(new Error("Cannot find module '@curl-erp/channel-not-installed'")),
      )

      const byId = new Map(statuses.map((status) => [status.id, status]))
      expect(byId.get('missing')?.availability).toBe('not_installed')
      expect(byId.get('present')?.availability).toBe('ready')
      expect(registry.find('present')).not.toBeNull()
      expect(registry.find('missing')).toBeNull()
    })

    it('reports an adapter that refuses to start', async () => {
      const registry = new ChannelRegistry()
      const [status] = await registry.load([{ id: 'broken', resolve: 'x' }], async () => ({
        createChannelAdapter: () => {
          throw new Error('bad credentials')
        },
      }))
      expect(status?.availability).toBe('failed')
      expect(status?.reason).toContain('bad credentials')
    })

    it('leaves a disabled channel alone', async () => {
      const registry = new ChannelRegistry()
      const [status] = await registry.load([{ id: 'off', resolve: 'x', enabled: false }], async () => ({
        createChannelAdapter: () => new MemoryChannelAdapter(),
      }))
      expect(status?.availability).toBe('disabled')
      expect(registry.size).toBe(0)
    })
  })

  describe('identifier mapping', () => {
    it('updates rather than duplicates on re-projection', async () => {
      const mappings = new ChannelMappings(db)
      const adapter = new MemoryChannelAdapter({ id: CHANNEL })

      const first = await adapter.publishProduct(PRODUCT)
      await mappings.link(CHANNEL, 'product', PRODUCT.localId, first.externalId)
      await mappings.linkMany(CHANNEL, 'variant', [...first.variants])

      const known = await mappings.externalIdFor(CHANNEL, 'product', PRODUCT.localId)
      const second = await adapter.publishProduct(PRODUCT, known ?? undefined)
      await mappings.link(CHANNEL, 'product', PRODUCT.localId, second.externalId)

      expect(second.externalId).toBe(first.externalId)
      expect(adapter.listings.size).toBe(1)
      expect(await db.select().from(channelMappings)).toHaveLength(3)
    })

    it('maps back from the channel’s identifiers', async () => {
      const mappings = new ChannelMappings(db)
      await mappings.link(CHANNEL, 'variant', 'var-1', 'ext-1')
      expect(await mappings.localIdFor(CHANNEL, 'variant', 'ext-1')).toBe('var-1')
      expect(await mappings.localIdFor(CHANNEL, 'variant', 'nope')).toBeNull()
    })
  })

  describe('what a channel may show', () => {
    it('withholds a group-restricted product from a channel that cannot enforce groups', () => {
      const restricted = { restrictedToGroups: ['professional'] }
      const withGroups = decidePublication(restricted, {
        customerGroups: true,
        priceLists: true,
        stockLevels: true,
        orderStatus: true,
        stockReporting: true,
      })
      const withoutGroups = decidePublication(restricted, {
        customerGroups: false,
        priceLists: false,
        stockLevels: false,
        orderStatus: false,
        stockReporting: false,
      })

      expect(withGroups.publish).toBe(true)
      expect(withoutGroups.publish).toBe(false)
      expect(withoutGroups.reason).toContain('professional')
    })

    it('publishes an unrestricted product anywhere', () => {
      expect(decidePublication({}, { customerGroups: false } as never).publish).toBe(true)
    })

    it('remembers per-channel selling rules', async () => {
      const publications = new ChannelPublications(db)
      expect(await publications.ruleFor(CHANNEL, 'var-1')).toMatchObject({
        listed: true,
        orderable: true,
        stockBuffer: 0,
      })

      await publications.set(CHANNEL, 'var-1', { orderable: false, stockBuffer: 2 })
      expect(await publications.ruleFor(CHANNEL, 'var-1')).toMatchObject({
        listed: true,
        orderable: false,
        stockBuffer: 2,
      })
      // Another channel is unaffected by the same variant's rule here.
      expect(await publications.ruleFor('marketplace', 'var-1')).toMatchObject({ orderable: true })
    })
  })

  describe('outbound queue', () => {
    it('keeps accepting work while the channel is down, then delivers it', async () => {
      const outbound = new ChannelOutbound(db, { baseBackoffMs: 0 })
      const adapter = new MemoryChannelAdapter({ id: CHANNEL, unreachable: true })

      await outbound.enqueue(CHANNEL, 'stock', 'var-1', { variantLocalId: 'var-1', available: 5 })

      const failed = await outbound.dispatch(CHANNEL, async () => {
        await adapter.publishStock([{ variantLocalId: 'var-1', available: 5 }])
      })
      expect(failed).toMatchObject({ sent: 0, failed: 1, remaining: 1 })

      const status = await outbound.status(CHANNEL)
      expect(status.pending).toBe(1)
      expect(status.failing).toBe(1)
      expect(status.oldestAgeMs).not.toBeNull()

      adapter.setUnreachable(false)
      await adapter.publishProduct(PRODUCT)
      const sent = await outbound.dispatch(CHANNEL, async (item) => {
        await adapter.publishStock([item.payload as never])
      })
      expect(sent).toMatchObject({ sent: 1, failed: 0, remaining: 0 })
    })

    it('collapses repeated instructions about the same thing', async () => {
      const outbound = new ChannelOutbound(db)
      for (const price of [100, 200, 300]) {
        await outbound.enqueue(CHANNEL, 'price', 'var-1', { priceMinor: price })
      }

      const pending = await outbound.pending(CHANNEL)
      expect(pending).toHaveLength(1)
      expect(pending[0]?.payload).toEqual({ priceMinor: 300 })
    })

    it('backs off after a failure instead of hammering', async () => {
      let now = new Date('2026-01-01T00:00:00Z')
      const outbound = new ChannelOutbound(db, { baseBackoffMs: 1000, now: () => now })
      await outbound.enqueue(CHANNEL, 'stock', 'var-1', {})

      await outbound.dispatch(CHANNEL, async () => {
        throw new Error('channel refused')
      })
      expect(await outbound.pending(CHANNEL)).toHaveLength(0)

      now = new Date(now.getTime() + 5000)
      expect(await outbound.pending(CHANNEL)).toHaveLength(1)
    })
  })

  describe('stock', () => {
    it('holds back the configured buffer', async () => {
      const stock = new ChannelStock(db, new InMemoryStock({ 'var-1': 10 }))
      await new ChannelPublications(db).set(CHANNEL, 'var-1', { stockBuffer: 3 })

      expect(await stock.levelsFor(CHANNEL, ['var-1'])).toEqual([{ variantLocalId: 'var-1', available: 7 }])
    })

    it('never publishes a negative quantity', async () => {
      const stock = new ChannelStock(db, new InMemoryStock({ 'var-1': 1 }))
      await new ChannelPublications(db).set(CHANNEL, 'var-1', { stockBuffer: 5 })
      expect(await stock.levelsFor(CHANNEL, ['var-1'])).toEqual([{ variantLocalId: 'var-1', available: 0 }])
    })

    it('shows nothing available for a variant that cannot be ordered', async () => {
      const stock = new ChannelStock(db, new InMemoryStock({ 'var-1': 10 }))
      await new ChannelPublications(db).set(CHANNEL, 'var-1', { orderable: false })
      expect(await stock.levelsFor(CHANNEL, ['var-1'])).toEqual([{ variantLocalId: 'var-1', available: 0 }])
    })

    it('corrects a channel that has drifted, and records what it found', async () => {
      const source = new InMemoryStock({ 'var-1': 3, 'var-2': 4 })
      const stock = new ChannelStock(db, source)
      const adapter = new MemoryChannelAdapter({ id: CHANNEL })
      const mappings = new ChannelMappings(db)

      const published = await adapter.publishProduct(PRODUCT)
      await mappings.linkMany(CHANNEL, 'variant', [...published.variants])
      await adapter.publishStock([
        { variantLocalId: 'var-1', available: 3 },
        { variantLocalId: 'var-2', available: 4 },
      ])

      // Somebody edits the shop by hand.
      adapter.setReportedStock('var-1', 9)

      const result = await stock.reconcile(CHANNEL, adapter)
      expect(result.corrected).toBe(1)
      expect(result.drift[0]).toMatchObject({ subject: 'var-1', expected: '3', actual: '9' })

      const afterwards = await adapter.fetchStock()
      const corrected = afterwards.find((entry) => entry.externalVariantId.endsWith('var-1'))
      expect(corrected?.available).toBe(3)
      expect(await stock.openDrift(CHANNEL)).toHaveLength(1)

      expect(await stock.resolveDrift(CHANNEL)).toBe(1)
      expect(await stock.openDrift(CHANNEL)).toHaveLength(0)
    })
  })

  describe('order intake', () => {
    const orderFor = (externalId: string, externalVariantId: string, quantity = 1): ChannelOrder => ({
      externalId,
      placedAt: new Date('2026-06-01T10:00:00Z'),
      currency: 'UAH',
      totalMinor: 49900 * quantity,
      lines: [{ externalVariantId, quantity, unitPriceMinor: 49900 }],
      customer: { externalId: 'cust-1', email: 'Buyer@Example.com', name: 'Buyer' },
    })

    it('records an order and links its customer', async () => {
      const mappings = new ChannelMappings(db)
      await mappings.link(CHANNEL, 'variant', 'var-1', 'ext-var-1')

      const orders = new ChannelOrders(db, { stock: new InMemoryStock({ 'var-1': 5 }) })
      const result = await orders.receive(CHANNEL, [orderFor('o-1', 'ext-var-1')])

      expect(result).toMatchObject({ received: 1, accepted: 1, parked: 0, oversold: 0 })
      const stored = await orders.find(CHANNEL, 'o-1')
      expect(stored?.state).toBe('accepted')
      expect(stored?.counterpartyId).not.toBeNull()

      const [party] = await db.select().from(counterparties)
      expect(party?.email).toBe('buyer@example.com')
    })

    it('ignores an order it has already seen', async () => {
      const mappings = new ChannelMappings(db)
      await mappings.link(CHANNEL, 'variant', 'var-1', 'ext-var-1')
      const orders = new ChannelOrders(db)

      await orders.receive(CHANNEL, [orderFor('o-1', 'ext-var-1')])
      const second = await orders.receive(CHANNEL, [orderFor('o-1', 'ext-var-1')])

      expect(second).toMatchObject({ duplicates: 1, accepted: 0 })
      expect(await orders.list(CHANNEL)).toHaveLength(1)
    })

    it('parks an order naming a variant it cannot map, instead of losing it', async () => {
      const orders = new ChannelOrders(db)
      const result = await orders.receive(CHANNEL, [orderFor('o-2', 'unknown-variant')])

      expect(result).toMatchObject({ parked: 1, accepted: 0 })
      const parked = await orders.list(CHANNEL, 'parked')
      expect(parked).toHaveLength(1)
      expect(parked[0]?.parkedReason).toContain('unknown-variant')
      // Everything the channel sent is kept, so a person can sort it out.
      expect(parked[0]?.payload['externalId']).toBe('o-2')
    })

    it('flags an order it cannot cover rather than refusing it', async () => {
      const mappings = new ChannelMappings(db)
      await mappings.link(CHANNEL, 'variant', 'var-1', 'ext-var-1')
      const orders = new ChannelOrders(db, { stock: new InMemoryStock({ 'var-1': 1 }) })

      const result = await orders.receive(CHANNEL, [orderFor('o-3', 'ext-var-1', 5)])
      expect(result).toMatchObject({ oversold: 1 })

      const stored = await orders.find(CHANNEL, 'o-3')
      expect(stored?.state).toBe('oversold')
      expect(stored?.parkedReason).toContain('var-1')
    })

    it('lets a person resolve a parked order', async () => {
      const orders = new ChannelOrders(db)
      await orders.receive(CHANNEL, [orderFor('o-4', 'unknown')])
      await orders.resolve(CHANNEL, 'o-4')

      expect((await orders.find(CHANNEL, 'o-4'))?.state).toBe('accepted')
      expect(await orders.list(CHANNEL, 'parked')).toHaveLength(0)
    })

    it('announces every arrival in the change feed', async () => {
      const mappings = new ChannelMappings(db)
      await mappings.link(CHANNEL, 'variant', 'var-1', 'ext-var-1')
      await new ChannelOrders(db).receive(CHANNEL, [orderFor('o-5', 'ext-var-1')])

      const events = await new ChangeFeedReader(db).read(0)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        entityType: 'channel_order',
        entityId: `${CHANNEL}:o-5`,
        actor: { type: 'integration', id: CHANNEL },
      })
    })

    it('fetches only what is new since last time', async () => {
      const adapter = new MemoryChannelAdapter({ id: CHANNEL })
      const published = await adapter.publishProduct(PRODUCT)
      const externalVariantId = published.variants[0]?.externalId ?? ''
      await new ChannelMappings(db).linkMany(CHANNEL, 'variant', [...published.variants])

      const orders = new ChannelOrders(db)
      adapter.placeOrder(orderFor('o-old', externalVariantId))
      expect(await orders.fetch(CHANNEL, adapter)).toMatchObject({ received: 1 })

      adapter.placeOrder({
        ...orderFor('o-new', externalVariantId),
        placedAt: new Date('2026-07-01T10:00:00Z'),
      })
      const second = await orders.fetch(CHANNEL, adapter)
      expect(second).toMatchObject({ received: 1, accepted: 1, duplicates: 0 })
    })

    it('queues a status change instead of demanding the channel be up', async () => {
      const orders = new ChannelOrders(db)
      await orders.publishStatus(CHANNEL, {
        externalOrderId: 'o-1',
        status: 'shipped',
        trackingReference: '20450000000000',
      })

      const pending = await new ChannelOutbound(db).pending(CHANNEL)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({ kind: 'order_status', subject: 'o-1' })
    })
  })

  describe('customers', () => {
    it('recognises a returning customer by email', async () => {
      const customers = new ChannelCustomers(db)
      const first = await customers.resolve(CHANNEL, {
        externalId: 'c-1',
        email: 'repeat@example.com',
      })
      const again = await customers.resolve('marketplace', {
        externalId: 'other-id',
        email: 'Repeat@Example.com',
      })

      expect(again.id).toBe(first.id)
      expect(await db.select().from(counterparties)).toHaveLength(1)
    })

    it('recognises a returning customer by phone, however it is written', async () => {
      const customers = new ChannelCustomers(db)
      const first = await customers.resolve(CHANNEL, {
        externalId: 'c-2',
        phone: '+38 (044) 123-45-67',
      })
      const again = await customers.resolve(CHANNEL, {
        externalId: 'c-3',
        phone: '380441234567',
      })
      expect(again.id).toBe(first.id)
    })

    it('creates someone new when nothing matches', async () => {
      const customers = new ChannelCustomers(db)
      await customers.resolve(CHANNEL, { externalId: 'c-4', email: 'a@example.com' })
      await customers.resolve(CHANNEL, { externalId: 'c-5', email: 'b@example.com' })
      expect(await db.select().from(counterparties)).toHaveLength(2)
    })

    it('gives a wholesale customer their own price list', async () => {
      const customers = new ChannelCustomers(db)
      const party = await customers.resolve(CHANNEL, {
        externalId: 'c-6',
        email: 'salon@example.com',
      })
      await customers.setGroup(party.id, 'wholesale')

      expect(await customers.priceListFor(CHANNEL, 'c-6')).toBe('wholesale')
      expect(await customers.priceListFor(CHANNEL, 'c-unknown')).toBeNull()
    })

    it('can be told not to match on anything', async () => {
      const strict = new ChannelCustomers(db, { byEmail: false, byPhone: false })
      await strict.resolve(CHANNEL, { externalId: 'c-7', email: 'same@example.com' })
      await strict.resolve(CHANNEL, { externalId: 'c-8', email: 'same@example.com' })
      expect(await db.select().from(counterparties)).toHaveLength(2)
    })
  })

  describe('money', () => {
    it('records a payment once, however many times it is announced', async () => {
      const payments = new ChannelPayments(db)
      const notification = {
        channel: CHANNEL,
        externalOrderId: 'o-1',
        reference: 'bank-ref-1',
        amountMinor: 49900,
        currency: 'UAH',
        paidAt: new Date(),
      }

      expect(await payments.record(notification)).toEqual({ recorded: true, duplicate: false })
      expect(await payments.record(notification)).toEqual({ recorded: false, duplicate: true })

      expect(await payments.paymentsFor(CHANNEL, 'o-1')).toHaveLength(1)
      expect(await payments.totalPaidMinor(CHANNEL, 'o-1')).toBe(49900)
    })

    it('tells the channel an order is paid only once', async () => {
      const payments = new ChannelPayments(db)
      const notification = {
        channel: CHANNEL,
        externalOrderId: 'o-2',
        reference: 'bank-ref-2',
        amountMinor: 1000,
        currency: 'UAH',
        paidAt: new Date(),
      }
      await payments.record(notification)
      await payments.record(notification)

      const pending = await new ChannelOutbound(db).pending(CHANNEL)
      expect(pending).toHaveLength(1)
      expect(pending[0]?.payload).toMatchObject({ status: 'paid' })
    })

    it('does not believe a channel that says an order is paid', async () => {
      const payments = new ChannelPayments(db)
      expect(await payments.isPaid(CHANNEL, 'o-3')).toBe(false)

      const mismatch = await payments.checkClaim(CHANNEL, 'o-3', true)
      expect(mismatch).toMatchObject({ claimedByChannel: true, recordedInCore: false })
    })

    it('reports nothing when the two agree', async () => {
      const payments = new ChannelPayments(db)
      await payments.record({
        channel: CHANNEL,
        externalOrderId: 'o-4',
        reference: 'bank-ref-4',
        amountMinor: 500,
        currency: 'UAH',
        paidAt: new Date(),
      })
      expect(await payments.checkClaim(CHANNEL, 'o-4', true)).toBeNull()
    })
  })
})

describe('journal to channel', () => {
  let fixture: TenantFixture
  let db: Database

  /** A catalog held in memory, standing in for the capability that owns it. */
  class TestCatalog {
    readonly products = new Map<string, ChannelProductInput>()

    add(product: ChannelProductInput): void {
      this.products.set(product.localId, product)
    }

    async productFor(productLocalId: string): Promise<ChannelProductInput | null> {
      return this.products.get(productLocalId) ?? null
    }

    async productIdForVariant(variantLocalId: string): Promise<string | null> {
      for (const product of this.products.values()) {
        if (product.variants.some((variant) => variant.localId === variantLocalId)) {
          return product.localId
        }
      }
      return null
    }
  }

  beforeAll(async () => {
    fixture = await createTenantFixture(['sync'], { migrate: true })
    db = fixture.registry.connectTo(fixture.tenant('sync')).db
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.delete(channelOutbound)
    await db.delete(channelMappings)
    await db.delete(channelPublications)
    await db.delete(changeEvents)
    await db.execute(sql`delete from feed_consumers`)
  })

  it('queues a publish when the journal says a product changed', async () => {
    const catalog = new TestCatalog()
    catalog.add(PRODUCT)
    const sync = new ChannelSync(db, CHANNEL, { catalog })
    const adapter = new MemoryChannelAdapter({ id: CHANNEL })

    await recordChange(db, { entityType: 'product', entityId: 'prod-1', kind: 'created' })
    expect(await sync.pull()).toMatchObject({ delivered: 1, queued: 1 })

    const pushed = await sync.push(adapter)
    expect(pushed).toMatchObject({ sent: 1, failed: 0 })
    expect(adapter.listings.size).toBe(1)

    // And the identifiers are remembered, so the next change updates.
    const mappings = new ChannelMappings(db)
    expect(await mappings.externalIdFor(CHANNEL, 'product', 'prod-1')).not.toBeNull()
    expect(await mappings.externalIdFor(CHANNEL, 'variant', 'var-1')).not.toBeNull()
  })

  it('updates the same listing on a second change', async () => {
    const catalog = new TestCatalog()
    catalog.add(PRODUCT)
    const sync = new ChannelSync(db, CHANNEL, { catalog })
    const adapter = new MemoryChannelAdapter({ id: CHANNEL })

    await recordChange(db, { entityType: 'product', entityId: 'prod-1', kind: 'created' })
    await sync.pull()
    await sync.push(adapter)

    catalog.add({ ...PRODUCT, title: 'Curl cream, new recipe' })
    await recordChange(db, { entityType: 'product', entityId: 'prod-1', kind: 'updated' })
    await sync.pull()
    await sync.push(adapter)

    expect(adapter.listings.size).toBe(1)
    expect([...adapter.listings.values()][0]?.product.title).toBe('Curl cream, new recipe')
  })

  it('ignores journal entries that are not about a shop', async () => {
    const sync = new ChannelSync(db, CHANNEL, { catalog: new TestCatalog() })
    await recordChange(db, { entityType: 'ledger_entry', entityId: 'l-1', kind: 'created' })
    expect(await sync.pull()).toMatchObject({ queued: 0, skipped: 1 })
    expect(await new ChannelOutbound(db).pending(CHANNEL)).toHaveLength(0)
  })

  it('takes a product down when it is deleted', async () => {
    const catalog = new TestCatalog()
    catalog.add(PRODUCT)
    const sync = new ChannelSync(db, CHANNEL, { catalog })
    const adapter = new MemoryChannelAdapter({ id: CHANNEL })

    await recordChange(db, { entityType: 'product', entityId: 'prod-1', kind: 'created' })
    await sync.pull()
    await sync.push(adapter)
    expect(adapter.listings.size).toBe(1)

    await recordChange(db, { entityType: 'product', entityId: 'prod-1', kind: 'deleted' })
    await sync.pull()
    await sync.push(adapter)
    expect(adapter.listings.size).toBe(0)
  })

  it('withholds a group-restricted product from a channel that cannot enforce groups', async () => {
    const catalog = new TestCatalog()
    catalog.add({ ...PRODUCT, restrictedToGroups: ['professional'] })
    const sync = new ChannelSync(db, CHANNEL, { catalog })
    const openChannel = new MemoryChannelAdapter({
      id: CHANNEL,
      capabilities: { customerGroups: false },
    })

    await recordChange(db, { entityType: 'product', entityId: 'prod-1', kind: 'created' })
    await sync.pull()
    await sync.push(openChannel)

    expect(openChannel.listings.size).toBe(0)
  })

  it('takes down a product that becomes restricted after it was listed', async () => {
    const catalog = new TestCatalog()
    catalog.add(PRODUCT)
    const sync = new ChannelSync(db, CHANNEL, { catalog })
    const adapter = new MemoryChannelAdapter({
      id: CHANNEL,
      capabilities: { customerGroups: false },
    })

    await recordChange(db, { entityType: 'product', entityId: 'prod-1', kind: 'created' })
    await sync.pull()
    await sync.push(adapter)
    expect(adapter.listings.size).toBe(1)

    catalog.add({ ...PRODUCT, restrictedToGroups: ['professional'] })
    await recordChange(db, { entityType: 'product', entityId: 'prod-1', kind: 'updated' })
    await sync.pull()
    await sync.push(adapter)

    expect(adapter.listings.size).toBe(0)
  })

  it('keeps working while the channel is down, and catches up after', async () => {
    const catalog = new TestCatalog()
    catalog.add(PRODUCT)
    const sync = new ChannelSync(db, CHANNEL, { catalog })
    const adapter = new MemoryChannelAdapter({ id: CHANNEL, unreachable: true })

    await recordChange(db, { entityType: 'product', entityId: 'prod-1', kind: 'created' })
    // Recording the change succeeded even though the shop is unreachable.
    await sync.pull()
    expect(await sync.push(adapter)).toMatchObject({ sent: 0, failed: 1 })

    adapter.setUnreachable(false)
    // The queue backs off, so the item is not due yet; a queue with no backoff
    // delivers immediately.
    const immediate = new ChannelSync(db, CHANNEL, { catalog })
    await new ChannelOutbound(db).enqueue(CHANNEL, 'product', 'prod-1', {
      productLocalId: 'prod-1',
    })
    expect(await immediate.push(adapter)).toMatchObject({ sent: 1 })
    expect(adapter.listings.size).toBe(1)
  })

  it('gives each channel its own place in the journal', async () => {
    const catalog = new TestCatalog()
    catalog.add(PRODUCT)
    const shop = new ChannelSync(db, 'shop', { catalog })
    const marketplace = new ChannelSync(db, 'marketplace', { catalog })
    await shop.register()
    await marketplace.register()

    await recordChange(db, { entityType: 'product', entityId: 'prod-1', kind: 'created' })
    await shop.pull()

    // The marketplace has not caught up yet, and is unaffected by the shop.
    expect(await new ChannelOutbound(db).pending('marketplace')).toHaveLength(0)
    await marketplace.pull()
    expect(await new ChannelOutbound(db).pending('marketplace')).toHaveLength(1)
  })

  it('re-sends everything on request', async () => {
    const catalog = new TestCatalog()
    catalog.add(PRODUCT)
    const sync = new ChannelSync(db, CHANNEL, { catalog })
    await new ChannelPublications(db).set(CHANNEL, 'var-1', { listed: true })

    expect(await sync.reproject()).toBe(1)
    expect(await new ChannelOutbound(db).pending(CHANNEL)).toHaveLength(1)
  })

  it('publishes stock when the journal reports a movement', async () => {
    const catalog = new TestCatalog()
    catalog.add(PRODUCT)
    const stock = new InMemoryStock({ 'var-1': 4 })
    const sync = new ChannelSync(db, CHANNEL, { catalog, stock })

    await recordChange(db, { entityType: 'stock', entityId: 'var-1', kind: 'updated' })
    expect(await sync.pull()).toMatchObject({ queued: 1 })

    const pending = await new ChannelOutbound(db).pending(CHANNEL)
    expect(pending[0]).toMatchObject({ kind: 'stock', subject: 'var-1' })
    expect(pending[0]?.payload).toMatchObject({ available: 4 })
  })
})
