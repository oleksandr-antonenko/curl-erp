import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/client.js'
import { runInTenantScope } from '../tenancy/context.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import {
  ContractorInUseError,
  Contractors,
  DuplicateIdentityError,
  RoleNotPlayedError,
} from './contractors.js'

describe('contractors', () => {
  let fixture: TenantFixture
  let db: Database
  let scoped: <T>(fn: () => Promise<T>) => Promise<T>

  beforeAll(async () => {
    fixture = await createTenantFixture(['contractors'], { migrate: true })
    const tenant = fixture.tenant('contractors')
    db = fixture.registry.connectTo(tenant).db
    scoped = (fn) => runInTenantScope({ tenant, db, actor: { type: 'human', id: 'staff-1' } }, fn)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(sql`truncate table contractors restart identity cascade`)
  })

  it('refuses a registry code that already belongs to somebody here', async () => {
    const contractors = new Contractors(db)
    await scoped(() =>
      contractors.create({ name: 'ТОВ "Міллі"', registryCode: '41146965', roles: ['supplier'] }),
    )

    await expect(
      scoped(() => contractors.create({ name: 'Інша назва', registryCode: '41146965', roles: ['supplier'] })),
    ).rejects.toThrow(DuplicateIdentityError)
    // And it names who holds it, so a person can go and look.
    await expect(
      scoped(() => contractors.create({ name: 'Інша назва', registryCode: '41146965', roles: ['supplier'] })),
    ).rejects.toThrow(/Міллі/)
  })

  it('lets two tenants record the same supplier', async () => {
    const other = await createTenantFixture(['other'], { migrate: true })
    try {
      const contractors = new Contractors(db)
      await scoped(() =>
        contractors.create({ name: 'ТОВ "Міллі"', registryCode: '41146965', roles: ['supplier'] }),
      )

      const otherTenant = other.tenant('other')
      const otherDb = other.registry.connectTo(otherTenant).db
      const theirs = await runInTenantScope(
        { tenant: otherTenant, db: otherDb, actor: { type: 'human', id: 'staff-2' } },
        () =>
          new Contractors(otherDb).create({
            name: 'ТОВ "Міллі"',
            registryCode: '41146965',
            roles: ['supplier'],
          }),
      )
      // Two businesses may perfectly well buy from the same company.
      expect(theirs.registryCode).toBe('41146965')
    } finally {
      await other.dispose()
    }
  })

  it('insists on the role a document needs', async () => {
    const contractors = new Contractors(db)
    const salon = await scoped(() => contractors.create({ name: 'Салон', roles: ['customer'] }))

    await expect(scoped(() => contractors.require(salon.id, 'supplier'))).rejects.toThrow(RoleNotPlayedError)
    await expect(scoped(() => contractors.require(salon.id, 'customer'))).resolves.toMatchObject({
      name: 'Салон',
    })
  })

  it('deactivates rather than deletes one with history', async () => {
    const contractors = new Contractors(db, [{ heldBy: async () => 'supplier receipt 8872' }])
    const supplier = await scoped(() => contractors.create({ name: 'ТОВ "Міллі"', roles: ['supplier'] }))

    await expect(scoped(() => contractors.remove(supplier.id))).rejects.toThrow(ContractorInUseError)

    const deactivated = await scoped(() => contractors.deactivate(supplier.id))
    expect(deactivated.isActive).toBe(false)
    // Gone from the pickers, still readable on the documents that cite it.
    expect(await scoped(() => contractors.list({ role: 'supplier' }))).toHaveLength(0)
    expect(await scoped(() => contractors.find(supplier.id))).not.toBeNull()
  })

  it('lists by the role asked for', async () => {
    const contractors = new Contractors(db)
    await scoped(async () => {
      await contractors.create({ name: 'ТОВ "Міллі"', roles: ['supplier'] })
      await contractors.create({ name: 'Салон', roles: ['customer'] })
      await contractors.create({ name: 'Обидва', roles: ['supplier', 'customer'] })
    })

    expect(await scoped(() => contractors.list({ role: 'supplier' }))).toHaveLength(2)
    expect(await scoped(() => contractors.list({ role: 'customer' }))).toHaveLength(2)
  })

  it('refuses a contractor with no role and no name', async () => {
    const contractors = new Contractors(db)
    await expect(scoped(() => contractors.create({ name: '  ', roles: ['supplier'] }))).rejects.toThrow(
      /needs a name/,
    )
    await expect(scoped(() => contractors.create({ name: 'Хтось', roles: [] }))).rejects.toThrow(
      /at least one role/,
    )
  })

  it('announces a changed phone without the phone number', async () => {
    const contractors = new Contractors(db)
    const olga = await scoped(() => contractors.create({ name: 'Ольга', roles: ['customer'] }))
    await db.execute(sql`truncate table change_events restart identity`)

    const updated = await scoped(() => contractors.updateContact(olga.id, { phone: '+38 (067) 123-45-67' }))
    expect(updated.phone).toBe('380671234567')

    const events = await db.execute<{ changed_fields: string[] }>(
      sql`select changed_fields from change_events where entity_id = ${olga.id}`,
    )
    expect(events.rows).toEqual([{ changed_fields: ['phone'] }])
    expect(JSON.stringify(events.rows)).not.toContain('1234567')
  })
})
