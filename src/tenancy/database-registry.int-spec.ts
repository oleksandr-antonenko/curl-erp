import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { currentDb, runInTenantScope } from './context.js'
import { TenantNotFoundError } from './control-plane.js'
import { TenantSuspendedError } from './database-registry.js'

describe('tenant database registry', () => {
  let fixture: TenantFixture

  beforeAll(async () => {
    fixture = await createTenantFixture(['alpha', 'beta'])
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  it('connects each tenant to its own database', async () => {
    const alpha = await fixture.registry.connect('alpha')
    const beta = await fixture.registry.connect('beta')

    const nameOf = async (connection: typeof alpha): Promise<string> => {
      const result = await connection.db.execute(sql`select current_database() as name`)
      return (result.rows[0] as { name: string }).name
    }

    expect(await nameOf(alpha)).not.toBe(await nameOf(beta))
    expect(await nameOf(alpha)).toContain('alpha')
    expect(await nameOf(beta)).toContain('beta')
  })

  it('reuses one pool per tenant', async () => {
    const before = fixture.registry.openPools
    await fixture.registry.connect('alpha')
    await fixture.registry.connect('alpha')
    expect(fixture.registry.openPools).toBe(before)
  })

  it('keeps data written in one tenant invisible to the other', async () => {
    const alpha = await fixture.registry.connect('alpha')
    const beta = await fixture.registry.connect('beta')

    await alpha.db.execute(sql`create table isolation_probe (value text not null)`)
    await alpha.db.execute(sql`insert into isolation_probe (value) values ('alpha-only')`)

    const alphaRows = await alpha.db.execute(sql`select value from isolation_probe`)
    expect(alphaRows.rows).toEqual([{ value: 'alpha-only' }])

    await expect(beta.db.execute(sql`select value from isolation_probe`)).rejects.toThrow(/isolation_probe/)
  })

  it('binds the scope so ambient code reaches the right database', async () => {
    const alpha = await fixture.registry.connect('alpha')
    const beta = await fixture.registry.connect('beta')

    const readDatabaseName = async (): Promise<string> => {
      const result = await currentDb().execute(sql`select current_database() as name`)
      return (result.rows[0] as { name: string }).name
    }

    const [a, b] = await Promise.all([
      runInTenantScope({ tenant: alpha.tenant, db: alpha.db, actor: null }, readDatabaseName),
      runInTenantScope({ tenant: beta.tenant, db: beta.db, actor: null }, readDatabaseName),
    ])

    expect(a).toContain('alpha')
    expect(b).toContain('beta')
  })

  it('refuses a suspended tenant', async () => {
    await fixture.controlPlane.update('beta', { status: 'suspended' })
    await expect(fixture.registry.connect('beta')).rejects.toThrow(TenantSuspendedError)
    await fixture.controlPlane.update('beta', { status: 'active' })
  })

  it('refuses an unregistered tenant', async () => {
    await expect(fixture.registry.connect('gamma')).rejects.toThrow(TenantNotFoundError)
  })
})
