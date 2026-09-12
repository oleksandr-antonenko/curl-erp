import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Catalog } from '../catalog/products.js'
import { changeEvents } from '../change-feed/schema.js'
import type { Database } from '../db/client.js'
import { runInTenantScope } from '../tenancy/context.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { InsufficientLotError, Stock } from './stock.js'

describe('stock', () => {
  let fixture: TenantFixture
  let db: Database
  let scoped: <T>(fn: () => Promise<T>) => Promise<T>

  beforeAll(async () => {
    fixture = await createTenantFixture(['stock'], { migrate: true })
    const tenant = fixture.tenant('stock')
    db = fixture.registry.connectTo(tenant).db
    scoped = (fn) => runInTenantScope({ tenant, db, actor: { type: 'human', id: 'staff-1' } }, fn)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(sql`
      truncate table stock_lots, warehouses, change_events, product_variants, products
      restart identity cascade
    `)
  })

  async function given(): Promise<{ variantId: string; warehouseId: string }> {
    return scoped(async () => {
      const warehouse = await new Stock(db).createWarehouse({ code: 'main', name: 'Основний' })
      const product = await new Catalog(db).create({
        status: 'published',
        variants: [{ sku: 'TARA-FL-400', title: 'Флакон 400 мл' }],
        texts: [{ language: 'uk', title: 'Флакон' }],
      })
      const [variant] = product.variants
      if (variant === undefined) throw new Error('fixture needs a variant')
      return { variantId: variant.id, warehouseId: warehouse.id }
    })
  }

  it('keeps each delivery at the cost it arrived at', async () => {
    const { variantId, warehouseId } = await given()

    await scoped(async () => {
      const stock = new Stock(db)
      await db.transaction((tx) =>
        stock.receive(tx, {
          variantId,
          warehouseId,
          quantity: 300,
          amountMinor: 180_000,
          sourceType: 'supplier_receipt',
          sourceId: '00000000-0000-4000-8000-00000000000a',
        }),
      )
      // The supplier raised the price for the next delivery.
      await db.transaction((tx) =>
        stock.receive(tx, {
          variantId,
          warehouseId,
          quantity: 700,
          amountMinor: 577_500,
          sourceType: 'supplier_receipt',
          sourceId: '00000000-0000-4000-8000-00000000000b',
        }),
      )
    })

    const lots = await scoped(() => new Stock(db).lotsOf(variantId))
    expect(lots.map((lot) => lot.amountMinor)).toEqual([180_000, 577_500])

    const onHand = await scoped(() => new Stock(db).onHand(variantId))
    expect(onHand.quantity).toBe(1000)
    expect(onHand.valueMinor).toBe(757_500)
  })

  it('derives what is on hand from the lots rather than a counter', async () => {
    const { variantId, warehouseId } = await given()

    await scoped(() =>
      db.transaction((tx) =>
        new Stock(db).receive(tx, {
          variantId,
          warehouseId,
          quantity: 700,
          amountMinor: 2_810_000,
          sourceType: 'supplier_receipt',
          sourceId: '00000000-0000-4000-8000-00000000000c',
        }),
      ),
    )

    const stock = new Stock(db)
    const onHand = await scoped(() => stock.onHand(variantId))
    const lots = await scoped(() => stock.lotsOf(variantId))
    const recomputed = lots.reduce((sum, lot) => sum + lot.quantityRemaining, 0)
    expect(onHand.quantity).toBe(recomputed)
  })

  it('refuses to take more than a lot holds, and writes nothing', async () => {
    const { variantId, warehouseId } = await given()

    const lot = await scoped(() =>
      db.transaction((tx) =>
        new Stock(db).receive(tx, {
          variantId,
          warehouseId,
          quantity: 100,
          amountMinor: 100_000,
          sourceType: 'supplier_receipt',
          sourceId: '00000000-0000-4000-8000-00000000000d',
        }),
      ),
    )

    await expect(scoped(() => db.transaction((tx) => new Stock(db).take(tx, lot.id, 101)))).rejects.toThrow(
      InsufficientLotError,
    )

    const after = await scoped(() => new Stock(db).onHand(variantId))
    expect(after.quantity).toBe(100)
  })

  it('leaves no lot when the transaction that created it rolls back', async () => {
    const { variantId, warehouseId } = await given()

    await expect(
      scoped(() =>
        db.transaction(async (tx) => {
          await new Stock(db).receive(tx, {
            variantId,
            warehouseId,
            quantity: 100,
            amountMinor: 100_000,
            sourceType: 'supplier_receipt',
            sourceId: '00000000-0000-4000-8000-00000000000e',
          })
          throw new Error('the document failed after the lot was written')
        }),
      ),
    ).rejects.toThrow(/document failed/)

    // No stock, and no journal event claiming there is any.
    expect(await scoped(() => new Stock(db).onHand(variantId))).toMatchObject({ quantity: 0 })
    const events = await db.select().from(changeEvents)
    expect(events.filter((event) => event.entityType === 'stock_lot')).toHaveLength(0)
  })

  it('refuses a quantity or an amount that is not whole', async () => {
    const { variantId, warehouseId } = await given()
    const stock = new Stock(db)
    const base = {
      variantId,
      warehouseId,
      sourceType: 'supplier_receipt',
      sourceId: '00000000-0000-4000-8000-00000000000f',
    }

    await expect(
      scoped(() => db.transaction((tx) => stock.receive(tx, { ...base, quantity: 0, amountMinor: 1 }))),
    ).rejects.toThrow(/at least one/)
    await expect(
      scoped(() => db.transaction((tx) => stock.receive(tx, { ...base, quantity: 10, amountMinor: 10.5 }))),
    ).rejects.toThrow(/integer minor units/)
  })
})
