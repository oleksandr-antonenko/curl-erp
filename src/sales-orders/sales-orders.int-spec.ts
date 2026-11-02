import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Catalog } from '../catalog/products.js'
import type { ChannelOrder } from '../channels/contract.js'
import { ChannelMappings } from '../channels/mappings.js'
import { ChannelOrders } from '../channels/orders.js'
import { ChannelOutbound } from '../channels/outbound.js'
import type { Database } from '../db/client.js'
import { LegalEntities, LegalEntityInUseError } from '../legal-entities/legal-entities.js'
import { type Actor, runInTenantScope } from '../tenancy/context.js'
import type { TenantRecord } from '../tenancy/tenant.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import {
  EntityFixedError,
  PaymentEntityMismatchError,
  PersonRequiredError,
  SalesOrders,
  salesOrdersReferenceEntities,
  TRANSITIONS,
  TransitionRefusedError,
} from './sales-orders.js'
import { SALES_ORDER_STATUSES, type SalesOrderStatus, salesOrders } from './schema.js'

const CHANNEL = 'shop'
const PERSON: Actor = { type: 'human', id: 'manager-1' }

describe('sales orders', () => {
  let fixture: TenantFixture
  let tenant: TenantRecord
  let db: Database
  let as: <T>(actor: Actor, fn: () => Promise<T>) => Promise<T>
  let person: <T>(fn: () => Promise<T>) => Promise<T>
  let variantA: string
  let variantB: string
  let kuzmenko: string
  let antonenko: string

  beforeAll(async () => {
    fixture = await createTenantFixture(['orders'], { migrate: true })
    tenant = fixture.tenant('orders')
    db = fixture.registry.connectTo(tenant).db
    as = (actor, fn) => runInTenantScope({ tenant, db, actor }, fn)
    person = (fn) => as(PERSON, fn)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(sql`
      truncate table payments, sales_order_events, sales_order_withdrawn_numbers, sales_order_lines,
        sales_orders, channel_inbox_orders, channel_outbound, channel_mappings, counterparty_identities,
        contractors, legal_entity_payment_defaults, legal_entity_changes, document_sequences,
        legal_entities, change_events, product_variants, products restart identity cascade
    `)
    await person(async () => {
      const product = await new Catalog(db).create({
        status: 'published',
        variants: [
          { sku: 'CURL-250', title: '250 мл' },
          { sku: 'CURL-500', title: '500 мл' },
        ],
        texts: [{ language: 'uk', title: 'Крем для кучерів' }],
      })
      variantA = product.variants[0]?.id ?? ''
      variantB = product.variants[1]?.id ?? ''
      const mappings = new ChannelMappings(db)
      await mappings.link(CHANNEL, 'variant', variantA, 'ext-a')
      await mappings.link(CHANNEL, 'variant', variantB, 'ext-b')

      const entities = new LegalEntities(db)
      kuzmenko = (await entities.register({ name: 'ФОП А', registryCode: '1111111111' })).id
      antonenko = (await entities.register({ name: 'ФОП Б', registryCode: '2222222222' })).id
      await entities.setPaymentDefault('card_link', kuzmenko)
    })
  })

  const order = (externalId: string, overrides: Partial<ChannelOrder> = {}): ChannelOrder => ({
    externalId,
    placedAt: new Date('2026-11-02T09:00:00Z'),
    currency: 'UAH',
    totalMinor: 2 * 34_900 + 61_000 + 8_000,
    shippingMinor: 8_000,
    lines: [
      { externalVariantId: 'ext-a', quantity: 2, unitPriceMinor: 34_900 },
      { externalVariantId: 'ext-b', quantity: 1, unitPriceMinor: 61_000 },
    ],
    customer: { externalId: `cus-${externalId}`, email: `${externalId}@example.com`, name: 'Покупець' },
    paymentMethod: 'bank_transfer',
    delivery: { city: 'Київ', address: 'Відділення 12' },
    ...overrides,
  })

  async function arrive(...orders: ChannelOrder[]): Promise<SalesOrders> {
    await new ChannelOrders(db).receive(CHANNEL, orders)
    const sales = new SalesOrders(db)
    await sales.materialise(CHANNEL)
    return sales
  }

  async function only(sales: SalesOrders, externalId: string) {
    const found = await sales.findByChannelOrder(CHANNEL, externalId)
    if (found === null) throw new Error(`no sales order for ${externalId}`)
    return found
  }

  describe('arriving from a channel', () => {
    it('becomes one new order with the charged prices and delivery apart', async () => {
      const sales = await arrive(order('o-1'))
      const created = await only(sales, 'o-1')
      expect(created).toMatchObject({
        status: 'new',
        number: null,
        legalEntityId: null,
        itemsMinor: 130_800,
        shippingMinor: 8_000,
        totalMinor: 138_800,
        outstandingMinor: 138_800,
        paymentMethod: 'bank_transfer',
        delivery: { city: 'Київ', address: 'Відділення 12' },
      })
      expect(created.lines).toEqual([
        { position: 1, variantId: variantA, quantity: 2, unitPriceMinor: 34_900, lineTotalMinor: 69_800 },
        { position: 2, variantId: variantB, quantity: 1, unitPriceMinor: 61_000, lineTotalMinor: 61_000 },
      ])
    })

    it('stays one order however many times it is delivered and materialised', async () => {
      const sales = await arrive(order('o-1'))
      await new ChannelOrders(db).receive(CHANNEL, [order('o-1')])
      expect(await sales.materialise(CHANNEL)).toBe(0)
      expect(await db.select().from(salesOrders)).toHaveLength(1)
    })

    it('makes nothing of an order whose totals do not reconcile, until resolved', async () => {
      const sales = await arrive(order('o-2', { totalMinor: 138_850 }))
      expect(await sales.findByChannelOrder(CHANNEL, 'o-2')).toBeNull()
      const queue = await sales.queue()
      expect(queue.parked).toEqual([
        expect.objectContaining({ externalId: 'o-2', reason: expect.stringContaining('difference 50') }),
      ])
    })

    it('takes the price the channel charged, not one from a price list', async () => {
      // No price list holds these variants at all: the line can only have come
      // from what the customer was charged, so a later list change cannot move it.
      const prices = await db.execute(sql`select count(*)::int as n from variant_prices`)
      expect(prices.rows[0]).toEqual({ n: 0 })
      const sales = await arrive(order('o-3'))
      expect((await only(sales, 'o-3')).lines.map((line) => line.unitPriceMinor)).toEqual([34_900, 61_000])
    })
  })

  describe('the legal entity', () => {
    it('is suggested from the payment method, and the order stays new until a person confirms', async () => {
      const sales = await arrive(order('o-1', { paymentMethod: 'card_link' }))
      const created = await only(sales, 'o-1')
      expect(created).toMatchObject({ suggestedEntityId: kuzmenko, legalEntityId: null, status: 'new' })

      const confirmed = await person(() => sales.confirmEntity(created.id, kuzmenko))
      expect(confirmed).toMatchObject({
        status: 'confirmed',
        legalEntityId: kuzmenko,
        number: 1,
        entityConfirmedBy: { type: 'human', id: 'manager-1' },
      })
    })

    it('has no suggestion for a bank transfer without a default', async () => {
      const sales = await arrive(order('o-1'))
      expect((await only(sales, 'o-1')).suggestedEntityId).toBeNull()
    })

    it('cannot be confirmed by an integration or a bot', async () => {
      const sales = await arrive(order('o-1', { paymentMethod: 'card_link' }))
      const created = await only(sales, 'o-1')
      await expect(
        as({ type: 'integration', id: 'shop' }, () => sales.confirmEntity(created.id, kuzmenko)),
      ).rejects.toThrow(PersonRequiredError)
      await expect(
        as({ type: 'bot', id: 'assistant' }, () => sales.confirmEntity(created.id, kuzmenko)),
      ).rejects.toThrow(PersonRequiredError)
    })

    it('numbers per entity, and a retried confirmation keeps its one number', async () => {
      const sales = await arrive(order('o-1'), order('o-2'), order('o-3'))
      const [a, b, c] = await Promise.all(['o-1', 'o-2', 'o-3'].map((id) => only(sales, id)))
      if (a === undefined || b === undefined || c === undefined) throw new Error('missing')

      expect((await person(() => sales.confirmEntity(a.id, kuzmenko))).number).toBe(1)
      expect((await person(() => sales.confirmEntity(b.id, antonenko))).number).toBe(1)
      expect((await person(() => sales.confirmEntity(c.id, kuzmenko))).number).toBe(2)
      expect((await person(() => sales.confirmEntity(a.id, kuzmenko))).number).toBe(1)

      const next = await arrive(order('o-4'))
      const d = await only(next, 'o-4')
      expect((await person(() => sales.confirmEntity(d.id, kuzmenko))).number).toBe(3)
    })

    it('can be changed before payment: a new number, the old one withdrawn', async () => {
      const sales = await arrive(order('o-1'))
      const created = await only(sales, 'o-1')
      await person(() => sales.confirmEntity(created.id, kuzmenko))

      const moved = await person(() => sales.changeEntity(created.id, antonenko))
      expect(moved).toMatchObject({ legalEntityId: antonenko, number: 1 })
      expect(await sales.withdrawnNumbers(created.id)).toEqual([{ legalEntityId: kuzmenko, number: 1 }])

      // Entity A's sequence moves on rather than reissuing the withdrawn number.
      const other = await only(await arrive(order('o-2')), 'o-2')
      expect((await person(() => sales.confirmEntity(other.id, kuzmenko))).number).toBe(2)

      const events = await sales.events(created.id)
      expect(events.map((event) => event.kind)).toEqual([
        'status',
        'entity_confirmed',
        'status',
        'entity_changed',
      ])
    })

    it('is fixed once a payment is recorded', async () => {
      const sales = await arrive(order('o-1'))
      const created = await only(sales, 'o-1')
      await person(() => sales.confirmEntity(created.id, kuzmenko))
      await person(() =>
        sales.recordPayment({
          orderId: created.id,
          amountMinor: 10_000,
          currency: 'UAH',
          paidAt: new Date(),
          source: 'manual',
          reference: 'form-1',
        }),
      )
      await expect(person(() => sales.changeEntity(created.id, antonenko))).rejects.toThrow(EntityFixedError)
    })

    it('keeps an entity that orders use from being deleted', async () => {
      const sales = await arrive(order('o-1', { paymentMethod: 'card_link' }))
      const created = await only(sales, 'o-1')
      await person(() => sales.confirmEntity(created.id, kuzmenko))
      const entities = new LegalEntities(db, [salesOrdersReferenceEntities])
      await expect(person(() => entities.remove(kuzmenko))).rejects.toThrow(LegalEntityInUseError)
    })
  })

  describe('payments', () => {
    async function confirmed(externalId: string, entity: () => string) {
      const sales = await arrive(order(externalId))
      const created = await only(sales, externalId)
      await person(() => sales.confirmEntity(created.id, entity()))
      return { sales, id: created.id }
    }

    it('makes the order paid when a person records the full total', async () => {
      const { sales, id } = await confirmed('o-1', () => kuzmenko)
      const result = await person(() =>
        sales.recordPayment({
          orderId: id,
          amountMinor: 138_800,
          currency: 'UAH',
          paidAt: new Date(),
          source: 'manual',
          reference: 'form-1',
        }),
      )
      expect(result.order).toMatchObject({ status: 'paid', paidMinor: 138_800, outstandingMinor: 0 })
      expect(result.payment).toMatchObject({
        actorType: 'human',
        actorId: 'manager-1',
        legalEntityId: kuzmenko,
      })
    })

    it('leaves a partly paid order unpaid, showing what is outstanding', async () => {
      const { sales, id } = await confirmed('o-1', () => kuzmenko)
      const result = await person(() =>
        sales.recordPayment({
          orderId: id,
          amountMinor: 100_000,
          currency: 'UAH',
          paidAt: new Date(),
          source: 'manual',
          reference: 'form-1',
        }),
      )
      expect(result.order).toMatchObject({ status: 'confirmed', outstandingMinor: 38_800 })
    })

    it('records the same reference once', async () => {
      const { sales, id } = await confirmed('o-1', () => kuzmenko)
      const payment = {
        orderId: id,
        amountMinor: 138_800,
        currency: 'UAH',
        paidAt: new Date(),
        source: 'card_provider',
        reference: 'inv-77',
      }
      const integration: Actor = { type: 'integration', id: 'card_provider' }
      expect((await as(integration, () => sales.recordPayment(payment))).duplicate).toBe(false)
      expect((await as(integration, () => sales.recordPayment(payment))).duplicate).toBe(true)
      expect((await sales.require(id)).payments).toHaveLength(1)
    })

    it('refuses money that reached the other entity, and does not attach it', async () => {
      const { sales, id } = await confirmed('o-1', () => kuzmenko)
      await expect(
        person(() =>
          sales.recordPayment({
            orderId: id,
            amountMinor: 138_800,
            currency: 'UAH',
            paidAt: new Date(),
            source: 'manual',
            reference: 'form-1',
            legalEntityId: antonenko,
          }),
        ),
      ).rejects.toThrow(PaymentEntityMismatchError)
      expect((await sales.require(id)).payments).toHaveLength(0)
    })

    it('refuses a manual payment from anyone but a person', async () => {
      const { sales, id } = await confirmed('o-1', () => kuzmenko)
      await expect(
        as({ type: 'bot', id: 'assistant' }, () =>
          sales.recordPayment({
            orderId: id,
            amountMinor: 1,
            currency: 'UAH',
            paidAt: new Date(),
            source: 'manual',
            reference: 'x',
          }),
        ),
      ).rejects.toThrow(PersonRequiredError)
    })

    it('accepts card money before confirmation, then holds the person to that entity', async () => {
      const sales = await arrive(order('o-1', { paymentMethod: 'card_link' }))
      const created = await only(sales, 'o-1')
      await as({ type: 'integration', id: 'card_provider' }, () =>
        sales.recordPayment({
          orderId: created.id,
          amountMinor: 138_800,
          currency: 'UAH',
          paidAt: new Date(),
          source: 'card_provider',
          reference: 'inv-1',
          legalEntityId: kuzmenko,
        }),
      )
      expect((await sales.require(created.id)).status).toBe('new')

      await expect(person(() => sales.confirmEntity(created.id, antonenko))).rejects.toThrow(
        PaymentEntityMismatchError,
      )
      const confirmedOrder = await person(() => sales.confirmEntity(created.id, kuzmenko))
      expect(confirmedOrder.status).toBe('paid')
    })
  })

  describe('status', () => {
    it('allows exactly the transitions in the table', () => {
      const allowed: [SalesOrderStatus, SalesOrderStatus][] = [
        ['new', 'confirmed'],
        ['new', 'cancelled'],
        ['confirmed', 'paid'],
        ['confirmed', 'cancelled'],
        ['paid', 'shipped'],
        ['paid', 'refunded'],
        ['shipped', 'refunded'],
      ]
      for (const from of SALES_ORDER_STATUSES) {
        for (const to of SALES_ORDER_STATUSES) {
          const expected = allowed.some(([a, b]) => a === from && b === to)
          expect(TRANSITIONS[from].includes(to), `${from} -> ${to}`).toBe(expected)
        }
      }
    })

    it('ships a paid order with its tracking number', async () => {
      const sales = await arrive(order('o-1'))
      const { id } = await only(sales, 'o-1')
      await person(() => sales.confirmEntity(id, kuzmenko))
      await person(() =>
        sales.recordPayment({
          orderId: id,
          amountMinor: 138_800,
          currency: 'UAH',
          paidAt: new Date(),
          source: 'manual',
          reference: 'f',
        }),
      )
      const shipped = await person(() => sales.ship(id, '20450000000000'))
      expect(shipped).toMatchObject({ status: 'shipped', trackingReference: '20450000000000' })
    })

    it('refuses to ship an unpaid order', async () => {
      const sales = await arrive(order('o-1'))
      const { id } = await only(sales, 'o-1')
      await person(() => sales.confirmEntity(id, kuzmenko))
      await expect(person(() => sales.ship(id, '20450000000000'))).rejects.toThrow(TransitionRefusedError)
    })

    it('refuses to cancel a paid order and offers a refund instead', async () => {
      const sales = await arrive(order('o-1'))
      const { id } = await only(sales, 'o-1')
      await person(() => sales.confirmEntity(id, kuzmenko))
      await person(() =>
        sales.recordPayment({
          orderId: id,
          amountMinor: 138_800,
          currency: 'UAH',
          paidAt: new Date(),
          source: 'manual',
          reference: 'f',
        }),
      )
      await expect(person(() => sales.cancel(id))).rejects.toThrow(/refund/)
      expect((await person(() => sales.refund(id, 'customer returned it'))).status).toBe('refunded')
    })

    it('records who made every transition', async () => {
      const sales = await arrive(order('o-1'))
      const { id } = await only(sales, 'o-1')
      await person(() => sales.cancel(id, 'duplicate'))
      const events = await sales.events(id)
      expect(events[events.length - 1]).toMatchObject({
        kind: 'status',
        fromValue: 'new',
        toValue: 'cancelled',
        actorId: 'manager-1',
        note: 'duplicate',
      })
    })

    it('tells the channel even while it is down, and the order does not wait', async () => {
      const sales = await arrive(order('o-1'))
      const { id } = await only(sales, 'o-1')
      await person(() => sales.confirmEntity(id, kuzmenko))
      await person(() =>
        sales.recordPayment({
          orderId: id,
          amountMinor: 138_800,
          currency: 'UAH',
          paidAt: new Date(),
          source: 'manual',
          reference: 'f',
        }),
      )
      const shipped = await person(() => sales.ship(id, '20450000000000'))
      expect(shipped.status).toBe('shipped')

      const pending = await new ChannelOutbound(db).pending(CHANNEL)
      expect(pending.map((item) => item.payload)).toEqual([
        { externalOrderId: 'o-1', status: 'confirmed' },
        { externalOrderId: 'o-1', status: 'paid' },
        { externalOrderId: 'o-1', status: 'shipped', trackingReference: '20450000000000' },
      ])
    })
  })

  describe('the queue', () => {
    it('shows what waits for whom, with amounts from here', async () => {
      const sales = await arrive(order('o-1'), order('o-2'), order('o-3', { totalMinor: 1 }))
      const second = await only(sales, 'o-2')
      await person(() => sales.confirmEntity(second.id, antonenko))
      await person(() =>
        sales.recordPayment({
          orderId: second.id,
          amountMinor: 38_800,
          currency: 'UAH',
          paidAt: new Date(),
          source: 'manual',
          reference: 'f',
        }),
      )

      const queue = await sales.queue()
      expect(queue.awaitingEntity.map((o) => o.channelOrderId)).toEqual(['o-1'])
      expect(queue.awaitingPayment).toEqual([
        expect.objectContaining({ channelOrderId: 'o-2', outstandingMinor: 100_000 }),
      ])
      expect(queue.awaitingShipment).toEqual([])
      expect(queue.parked.map((p) => p.externalId)).toEqual(['o-3'])
    })
  })
})
