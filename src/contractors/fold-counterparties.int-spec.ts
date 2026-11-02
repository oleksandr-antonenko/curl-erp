import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '../db/client.js'
import { migrateTenant, migrationsFolder } from '../tenancy/migrations.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'

/**
 * Customers used to live in a table of their own. A running tenant has rows
 * there, identity links pointing at them and orders pointing at them; after the
 * fold every one of those must still reach the same customer.
 */
describe('folding counterparties into contractors', () => {
  let fixture: TenantFixture
  let db: Database
  let partialFolder: string

  beforeAll(async () => {
    fixture = await createTenantFixture(['fold'])
    db = fixture.registry.connectTo(fixture.tenant('fold')).db

    // A copy of the migrations that stops just before the fold.
    partialFolder = await mkdtemp(join(tmpdir(), 'erp-migrations-'))
    await cp(migrationsFolder(), partialFolder, { recursive: true })
    const journalPath = join(partialFolder, 'meta', '_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const foldAt = journal.entries.findIndex((entry) => entry.tag.endsWith('fold_counterparties'))
    expect(foldAt).toBeGreaterThan(0)
    journal.entries = journal.entries.slice(0, foldAt)
    await writeFile(journalPath, JSON.stringify(journal))
    await migrateTenant(db, partialFolder)
  })

  afterAll(async () => {
    await fixture.dispose()
    await rm(partialFolder, { recursive: true, force: true })
  })

  it('keeps every identity and inbox order linked to the same customer', async () => {
    const olga = '11111111-1111-4111-8111-111111111111'
    const salon = '22222222-2222-4222-8222-222222222222'
    await db.execute(sql`
      insert into counterparties (id, name, email, phone, customer_group) values
        (${olga}, 'Ольга', ' Olga@Salon.UA ', '+38 (067) 123-45-67', 'wholesale'),
        (${salon}, 'Салон', null, null, null)
    `)
    await db.execute(sql`
      insert into counterparty_identities (channel, external_id, counterparty_id) values
        ('shop', 'cus_1', ${olga}), ('shop', 'cus_2', ${salon})
    `)
    await db.execute(sql`
      insert into channel_inbox_orders (channel, external_id, placed_at, state, currency, total_minor, counterparty_id, payload)
      values ('shop', 'order_1', now(), 'accepted', 'UAH', 100, ${olga}, '{}')
    `)

    await migrateTenant(db)

    const customers = await db.execute<{
      id: string
      email: string | null
      phone: string | null
      customer_group: string | null
      roles: string[]
    }>(sql`select id, email, phone, customer_group, roles from contractors order by name`)
    expect(customers.rows).toEqual([
      {
        id: olga,
        email: 'olga@salon.ua',
        phone: '380671234567',
        customer_group: 'wholesale',
        roles: ['customer'],
      },
      { id: salon, email: null, phone: null, customer_group: null, roles: ['customer'] },
    ])

    const linked = await db.execute<{ external_id: string; name: string }>(sql`
      select i.external_id, c.name from counterparty_identities i
      join contractors c on c.id = i.counterparty_id order by i.external_id
    `)
    expect(linked.rows).toEqual([
      { external_id: 'cus_1', name: 'Ольга' },
      { external_id: 'cus_2', name: 'Салон' },
    ])

    const orders = await db.execute<{ name: string }>(sql`
      select c.name from channel_inbox_orders o join contractors c on c.id = o.counterparty_id
    `)
    expect(orders.rows).toEqual([{ name: 'Ольга' }])

    const leftover = await db.execute(sql`select to_regclass('counterparties') as t`)
    expect(leftover.rows[0]).toEqual({ t: null })
  })
})
