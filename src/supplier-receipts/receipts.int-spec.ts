import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Catalog } from '../catalog/products.js'
import { changeEvents } from '../change-feed/schema.js'
import { Contractors } from '../contractors/contractors.js'
import type { Database } from '../db/client.js'
import {
  LegalEntities,
  LegalEntityInactiveError,
  LegalEntityInUseError,
  LegalEntityNotFoundError,
} from '../legal-entities/legal-entities.js'
import { Stock } from '../stock/stock.js'
import { runInTenantScope } from '../tenancy/context.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { TotalMismatchError } from './money.js'
import {
  AlreadyPostedError,
  ReceiptError,
  SupplierReceipts,
  supplierReceiptsReferenceEntities,
  UnevidencedError,
  UnresolvedLinesError,
} from './receipts.js'
import type { InvoiceRecogniser, RecognisedInvoice } from './recognition.js'
import { RecognitionUnavailableError } from './recognition.js'

const ENTITY = '00000000-0000-4000-8000-000000000001'
const OTHER_ENTITY = '00000000-0000-4000-8000-000000000002'

describe('supplier receipts', () => {
  let fixture: TenantFixture
  let db: Database
  let scoped: <T>(fn: () => Promise<T>) => Promise<T>

  beforeAll(async () => {
    fixture = await createTenantFixture(['receipts'], { migrate: true })
    const tenant = fixture.tenant('receipts')
    db = fixture.registry.connectTo(tenant).db
    scoped = (fn) =>
      runInTenantScope({ tenant, db, actor: { type: 'human', id: 'staff-1', displayName: 'Олександр' } }, fn)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(sql`
      truncate table supplier_receipt_line_parts, supplier_receipt_lines, supplier_receipts,
        stock_lots, warehouses, contractors, documents, change_events,
        product_variants, products, legal_entities restart identity cascade
    `)
    await db.execute(sql`
      insert into legal_entities (id, name, registry_code, actor_type, actor_id) values
        (${ENTITY}, 'ФОП Перша', '1111111111', 'human', 'staff-1'),
        (${OTHER_ENTITY}, 'ФОП Друга', '2222222222', 'human', 'staff-1')
    `)
  })

  /** A supplier, a warehouse and two variants named as a real business names them. */
  async function given(): Promise<{
    supplierId: string
    warehouseId: string
    bottle200: string
    bottle400: string
  }> {
    return scoped(async () => {
      const contractors = new Contractors(db)
      const stock = new Stock(db)
      const catalog = new Catalog(db)

      const supplier = await contractors.create({
        name: 'ТОВ "Постачальник"',
        registryCode: '41146965',
        roles: ['supplier'],
      })
      const warehouse = await stock.createWarehouse({ code: 'main', name: 'Основний' })

      const product = await catalog.create({
        status: 'published',
        variants: [
          { sku: 'TARA-FL-200', title: 'Флакон 200 мл' },
          { sku: 'TARA-FL-400', title: 'Флакон 400 мл' },
        ],
        texts: [{ language: 'uk', title: 'Флакон' }],
      })

      const [v200, v400] = product.variants
      if (v200 === undefined || v400 === undefined) throw new Error('fixture needs two variants')
      return {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        bottle200: v200.id,
        bottle400: v400.id,
      }
    })
  }

  it('posts nothing until a person says so, and then writes stock once', async () => {
    const { supplierId, warehouseId, bottle200 } = await given()

    const posted = await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        number: '8872',
        statedTotalMinor: 495_000,
        sourceNote: 'Накладна на папері, підшита в теці',
        lines: [{ rawName: 'Флакон пластиковий 200 мл', quantity: 750, amountMinor: 495_000 }],
      })

      // A draft changes nothing at all.
      const before = await new Stock(db).onHand(bottle200)
      expect(before.quantity).toBe(0)

      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')
      await receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 750 }])
      return receipts.post(draft.id)
    })

    expect(posted.state).toBe('posted')
    expect(posted.obligationMinor).toBe(495_000)

    const onHand = await scoped(() => new Stock(db).onHand(bottle200))
    expect(onHand.quantity).toBe(750)
    expect(onHand.valueMinor).toBe(495_000)
  })

  it('refuses a second posting instead of doubling the stock', async () => {
    const { supplierId, warehouseId, bottle200 } = await given()

    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 100_000,
        sourceNote: 'Готівкова покупка',
        lines: [{ rawName: 'Флакон 200 мл', quantity: 100, amountMinor: 100_000 }],
      })
      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')
      await receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 100 }])
      await receipts.post(draft.id)

      await expect(receipts.post(draft.id)).rejects.toThrow(AlreadyPostedError)
    })

    const onHand = await scoped(() => new Stock(db).onHand(bottle200))
    expect(onHand.quantity).toBe(100)
  })

  it('splits one printed line across two variants, losing no kopeck', async () => {
    const { supplierId, warehouseId, bottle200, bottle400 } = await given()

    // The real line: "Дозатор алюмінієвий 24/410, 1 450 шт" for 13 862,00 —
    // 750 for one bottle size and 700 for another.
    const posted = await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 1_386_200,
        sourceNote: 'Накладна постачальника',
        lines: [{ rawName: 'Дозатор алюмінієвий 24/410', quantity: 1450, amountMinor: 1_386_200 }],
      })
      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')
      await receipts.resolveLine(line.id, [
        { variantId: bottle200, quantity: 750, amountMinor: 717_000 },
        { variantId: bottle400, quantity: 700, amountMinor: 669_200 },
      ])
      return receipts.post(draft.id)
    })

    const parts = posted.lines[0]?.parts ?? []
    expect(parts).toHaveLength(2)
    expect(parts.reduce((sum, part) => sum + part.amountMinor, 0)).toBe(1_386_200)
    // Every part produced a lot, and each lot knows which document brought it.
    expect(parts.every((part) => part.lotId !== null)).toBe(true)
  })

  it('refuses a split that does not account for the line', async () => {
    const { supplierId, warehouseId, bottle200, bottle400 } = await given()

    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 1_386_200,
        sourceNote: 'Накладна постачальника',
        lines: [{ rawName: 'Дозатор 24/410', quantity: 1450, amountMinor: 1_386_200 }],
      })
      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')

      // Counts short of the line.
      await expect(receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 750 }])).rejects.toThrow(
        /Parts count 750 but the line is 1450/,
      )

      // Counts right, money wrong.
      await expect(
        receipts.resolveLine(line.id, [
          { variantId: bottle200, quantity: 750, amountMinor: 717_000 },
          { variantId: bottle400, quantity: 700, amountMinor: 669_000 },
        ]),
      ).rejects.toThrow(TotalMismatchError)
    })
  })

  it('distributes a group amount across its lines exactly', async () => {
    const { supplierId, warehouseId, bottle200, bottle400 } = await given()

    // 28 100,00 over 100/100/250/250 is 40,142857... each and must still total.
    const draft = await scoped(() =>
      new SupplierReceipts(db).create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 2_810_000,
        sourceNote: 'Розпорядження власника',
        groups: [
          {
            amountMinor: 2_810_000,
            lines: [
              { rawName: 'Етикетка крок 1, 400 мл', quantity: 100 },
              { rawName: 'Етикетка крок 2, 400 мл', quantity: 100 },
              { rawName: 'Етикетка крок 3, 400 мл', quantity: 250 },
              { rawName: 'Етикетка крок 4, 400 мл', quantity: 250 },
            ],
          },
        ],
      }),
    )

    expect(draft.lines.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(2_810_000)
    void bottle200
    void bottle400
  })

  it('refuses to post while a line is unresolved, naming it', async () => {
    const { supplierId, warehouseId } = await given()

    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 100_000,
        sourceNote: 'Накладна',
        lines: [{ rawName: 'Транспортні послуги', quantity: 1, amountMinor: 100_000 }],
      })
      await expect(receipts.post(draft.id)).rejects.toThrow(UnresolvedLinesError)
    })
  })

  it('refuses to post with neither a document nor a stated source', async () => {
    const { supplierId, warehouseId, bottle200 } = await given()

    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 100_000,
        lines: [{ rawName: 'Флакон 200 мл', quantity: 100, amountMinor: 100_000 }],
      })
      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')
      await receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 100 }])

      await expect(receipts.post(draft.id)).rejects.toThrow(UnevidencedError)
    })
  })

  it('refuses a draft whose lines disagree with the supplier total', async () => {
    const { supplierId, warehouseId } = await given()

    await scoped(async () => {
      await expect(
        new SupplierReceipts(db).create({
          legalEntityId: ENTITY,
          supplierId,
          warehouseId,
          statedTotalMinor: 6_210_000,
          sourceNote: 'Накладна',
          lines: [{ rawName: 'Етикетки', quantity: 800, amountMinor: 3_400_000 }],
        }),
      ).rejects.toThrow(TotalMismatchError)
    })
  })

  it('records the actor that drafted and the actor that posted', async () => {
    const { supplierId, warehouseId, bottle200 } = await given()
    const tenant = fixture.tenant('receipts')

    const draft = await runInTenantScope(
      { tenant, db, actor: { type: 'integration', id: 'recogniser', conversationId: 'job-7' } },
      () =>
        new SupplierReceipts(db).create({
          legalEntityId: ENTITY,
          supplierId,
          warehouseId,
          statedTotalMinor: 100_000,
          sourceNote: 'Розпізнано з накладної',
          lines: [{ rawName: 'Флакон 200 мл', quantity: 100, amountMinor: 100_000 }],
        }),
    )

    const [line] = draft.lines
    if (line === undefined) throw new Error('draft should have a line')
    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      await receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 100 }])
      await receipts.post(draft.id)
    })

    const [row] = await db
      .execute<{
        created_actor_type: string
        created_actor_id: string
        posted_actor_type: string
        posted_actor_id: string
      }>(sql`select created_actor_type, created_actor_id, posted_actor_type, posted_actor_id
           from supplier_receipts where id = ${draft.id}`)
      .then((result) => result.rows)

    expect(row?.created_actor_type).toBe('integration')
    expect(row?.created_actor_id).toBe('recogniser')
    expect(row?.posted_actor_type).toBe('human')
    expect(row?.posted_actor_id).toBe('staff-1')
  })

  it('journals the posting in the same transaction', async () => {
    const { supplierId, warehouseId, bottle200 } = await given()

    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 100_000,
        sourceNote: 'Накладна',
        lines: [{ rawName: 'Флакон 200 мл', quantity: 100, amountMinor: 100_000 }],
      })
      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')
      await receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 100 }])
      await receipts.post(draft.id)
    })

    const events = await db.select().from(changeEvents)
    const kinds = events.map((event) => `${event.entityType}:${event.kind}`)
    expect(kinds).toContain('supplier_receipt:created')
    expect(kinds).toContain('supplier_receipt:updated')
    expect(kinds).toContain('stock_lot:created')
  })

  it('works with no recogniser installed, and says so', async () => {
    const { supplierId, warehouseId, bottle200 } = await given()

    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      expect(receipts.recognitionAvailable).toBe(false)
      await expect(
        receipts.recognise({ content: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      ).rejects.toThrow(RecognitionUnavailableError)

      // And the whole path still works by hand.
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 100_000,
        sourceNote: 'Введено вручну',
        lines: [{ rawName: 'Флакон 200 мл', quantity: 100, amountMinor: 100_000 }],
      })
      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')
      await receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 100 }])
      const posted = await receipts.post(draft.id)
      expect(posted.state).toBe('posted')
    })
  })

  it('keeps what the recogniser read beside what a person accepted', async () => {
    const { supplierId, warehouseId, bottle200 } = await given()

    const recognised: RecognisedInvoice = {
      number: '8872',
      lines: [{ name: 'Флакон пластиковий 200 мл', quantity: 145, amountMinor: 100_000 }],
      problems: ['кількість у рядку 1 надрукована нечітко'],
    }
    const recogniser: InvoiceRecogniser = { read: async () => recognised }

    const posted = await scoped(async () => {
      const receipts = new SupplierReceipts(db, new Stock(db), new Contractors(db), recogniser)
      expect(receipts.recognitionAvailable).toBe(true)

      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 100_000,
        sourceNote: 'Розпізнано',
        recognition: recognised,
        // A person read 100 where the machine read 145.
        lines: [{ rawName: 'Флакон пластиковий 200 мл', quantity: 100, amountMinor: 100_000 }],
      })
      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')
      await receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 100 }])
      return receipts.post(draft.id)
    })

    // The corrected figure is what the books hold...
    const onHand = await scoped(() => new Stock(db).onHand(bottle200))
    expect(onHand.quantity).toBe(100)
    // ...and the machine's original reading is still readable, problems included.
    expect(posted.recognition?.lines[0]?.quantity).toBe(145)
    expect(posted.recognition?.problems).toHaveLength(1)
  })

  it('proposes what a line might be and never picks for the person', async () => {
    const { supplierId, warehouseId } = await given()

    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 100_000,
        sourceNote: 'Накладна',
        lines: [
          { rawName: 'Флакон пластиковий Олівія 400 мл (Чорний)', quantity: 100, amountMinor: 100_000 },
        ],
      })
      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')

      const proposed = await receipts.proposeFor(line.id)
      expect(proposed.length).toBeGreaterThan(0)
      expect(proposed[0]?.sku).toBe('TARA-FL-400')
      // Proposing changed nothing: the line is still unresolved and unpostable.
      const reloaded = await receipts.find(draft.id)
      expect(reloaded?.lines[0]?.parts).toHaveLength(0)
      await expect(receipts.post(draft.id)).rejects.toThrow(UnresolvedLinesError)
    })
  })

  it('records what is owed and writes no money of any kind', async () => {
    const { supplierId, warehouseId, bottle200 } = await given()

    const posted = await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 3_682_700,
        sourceNote: 'Накладна № 8872',
        lines: [{ rawName: 'Флакон 200 мл', quantity: 750, amountMinor: 3_682_700 }],
      })
      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')
      await receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 750 }])
      return receipts.post(draft.id)
    })

    // The debt is on record...
    expect(posted.obligationMinor).toBe(3_682_700)

    // ...and nothing resembling a payment or an expense was written. The
    // payment for a delivery is a separate event that is often already
    // recorded; a second record of it is the double count this design exists
    // to prevent.
    // Money tables may exist (payments arrive with sales orders); posting a
    // receipt must leave every one of them empty. Configuration that merely
    // has "payment" in its name is not money.
    const moneyTables = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and (table_name like '%payment%' or table_name like '%expense%'
             or table_name like '%ledger%')
        and table_name not like 'channel%'
        and table_name <> 'legal_entity_payment_defaults'
    `)
    for (const { table_name } of moneyTables.rows) {
      const rows = await db.execute(sql`select 1 from ${sql.identifier(table_name)} limit 1`)
      expect(rows.rows, `${table_name} must stay empty`).toHaveLength(0)
    }

    // And the receipt exposes no way to write one.
    const surface = Object.getOwnPropertyNames(SupplierReceipts.prototype)
    expect(surface).not.toContain('pay')
    expect(surface).not.toContain('settle')
    expect(surface).not.toContain('recordExpense')
  })

  it('numbers documents per legal entity, not globally', async () => {
    const { supplierId, warehouseId } = await given()
    const other = OTHER_ENTITY

    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const common = {
        supplierId,
        warehouseId,
        number: '8872',
        statedTotalMinor: 0,
        sourceNote: 'Накладна',
      }
      await receipts.create({ ...common, legalEntityId: ENTITY })
      await receipts.create({ ...common, legalEntityId: other })

      // The same number under one entity is the clash that must be refused.
      await expect(receipts.create({ ...common, legalEntityId: ENTITY })).rejects.toThrow()
    })
  })

  it('refuses a receipt for an entity the tenant never registered, or retired', async () => {
    const { supplierId, warehouseId } = await given()
    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const common = { supplierId, warehouseId, statedTotalMinor: 0, sourceNote: 'Накладна' }
      await expect(
        receipts.create({ ...common, legalEntityId: '00000000-0000-4000-8000-0000000000ff' }),
      ).rejects.toThrow(LegalEntityNotFoundError)

      await new LegalEntities(db).deactivate(OTHER_ENTITY)
      await expect(receipts.create({ ...common, legalEntityId: OTHER_ENTITY })).rejects.toThrow(
        LegalEntityInactiveError,
      )

      // And an entity a receipt uses cannot be deleted.
      await receipts.create({ ...common, legalEntityId: ENTITY })
      await expect(new LegalEntities(db, [supplierReceiptsReferenceEntities]).remove(ENTITY)).rejects.toThrow(
        LegalEntityInUseError,
      )
    })
  })

  it('refuses a receipt from somebody who is not a supplier', async () => {
    const { warehouseId } = await given()

    await scoped(async () => {
      const customer = await new Contractors(db).create({
        name: 'Салон "Кучері"',
        roles: ['customer'],
      })
      await expect(
        new SupplierReceipts(db).create({
          legalEntityId: ENTITY,
          supplierId: customer.id,
          warehouseId,
          statedTotalMinor: 0,
          sourceNote: 'Накладна',
        }),
      ).rejects.toThrow(/does not act as supplier/)
    })
  })

  it('has no way to write a quantity or a cost directly', () => {
    const surface = Object.getOwnPropertyNames(Stock.prototype)
    expect(surface).not.toContain('setQuantity')
    expect(surface).not.toContain('setCost')
    expect(surface).not.toContain('adjust')
    // Everything that changes stock takes a document.
    expect(surface).toContain('receive')
  })

  it('refuses to change a line once the receipt is posted', async () => {
    const { supplierId, warehouseId, bottle200 } = await given()

    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 100_000,
        sourceNote: 'Накладна',
        lines: [{ rawName: 'Флакон 200 мл', quantity: 100, amountMinor: 100_000 }],
      })
      const [line] = draft.lines
      if (line === undefined) throw new Error('draft should have a line')
      await receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 100 }])
      await receipts.post(draft.id)

      await expect(receipts.resolveLine(line.id, [{ variantId: bottle200, quantity: 100 }])).rejects.toThrow(
        AlreadyPostedError,
      )
    })
  })

  it('posts nothing for a receipt with no lines', async () => {
    const { supplierId, warehouseId } = await given()

    await scoped(async () => {
      const receipts = new SupplierReceipts(db)
      const draft = await receipts.create({
        legalEntityId: ENTITY,
        supplierId,
        warehouseId,
        statedTotalMinor: 0,
        sourceNote: 'Накладна',
      })
      await expect(receipts.post(draft.id)).rejects.toThrow(ReceiptError)
    })
  })
})
