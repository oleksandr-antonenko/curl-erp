/**
 * The isolation suite.
 *
 * Every other test asks whether a feature works; this one asks whether one
 * customer can reach another's data. It is kept together and run as its own
 * step so that a failure here is never mistaken for an ordinary broken test:
 * for a system that holds several businesses' books, this is the claim that
 * must never quietly regress.
 */
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { currentDb, currentTenant, runInTenantScope } from './context.js'
import { TenantJobRunner } from './jobs.js'
import { migrateTenant, readSchemaVersion } from './migrations.js'
import { SecretsCipher, TenantSecretsStore } from './secrets.js'

describe('tenant isolation', () => {
  let fixture: TenantFixture
  const cipher = SecretsCipher.fromBase64Key(randomBytes(32).toString('base64'))

  beforeAll(async () => {
    fixture = await createTenantFixture([
      { id: 'alpha', hosts: ['alpha.example.com'] },
      { id: 'beta', hosts: ['beta.example.com'] },
    ])
    for (const id of ['alpha', 'beta']) {
      const connection = fixture.registry.connectTo(fixture.tenant(id))
      await migrateTenant(connection.db)
      await connection.db.execute(sql`create table ledger (entry text not null)`)
      await connection.db.execute(sql`insert into ledger (entry) values (${`${id}-money`})`)
    }
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  const entriesOf = async (id: string): Promise<string[]> => {
    const connection = await fixture.registry.connect(id)
    const result = await connection.db.execute<{ entry: string }>(sql`select entry from ledger`)
    return result.rows.map((row) => row.entry)
  }

  it('gives the two tenants physically separate databases', async () => {
    const alpha = await fixture.registry.connect('alpha')
    const beta = await fixture.registry.connect('beta')

    const nameOf = async (connection: typeof alpha): Promise<string> => {
      const result = await connection.db.execute<{ name: string }>(sql`select current_database() as name`)
      return result.rows[0]?.name ?? ''
    }

    expect(await nameOf(alpha)).not.toBe(await nameOf(beta))
  })

  it('shows each tenant only its own rows', async () => {
    expect(await entriesOf('alpha')).toEqual(['alpha-money'])
    expect(await entriesOf('beta')).toEqual(['beta-money'])
  })

  it('does not let a write in one tenant appear in the other', async () => {
    const alpha = await fixture.registry.connect('alpha')
    await alpha.db.execute(sql`insert into ledger (entry) values ('alpha-second')`)

    expect((await entriesOf('alpha')).sort()).toEqual(['alpha-money', 'alpha-second'])
    expect(await entriesOf('beta')).toEqual(['beta-money'])
  })

  it('does not let a table created in one tenant exist in the other', async () => {
    const alpha = await fixture.registry.connect('alpha')
    await alpha.db.execute(sql`create table alpha_only (value text)`)

    const beta = await fixture.registry.connect('beta')
    const found = await beta.db.execute<{ count: string }>(
      sql`select count(*)::text as count from information_schema.tables where table_name = 'alpha_only'`,
    )
    expect(found.rows[0]?.count).toBe('0')
  })

  it('keeps credentials apart', async () => {
    const alphaStore = new TenantSecretsStore(fixture.registry.connectTo(fixture.tenant('alpha')).db, cipher)
    const betaStore = new TenantSecretsStore(fixture.registry.connectTo(fixture.tenant('beta')).db, cipher)

    await alphaStore.set('bank.token', 'alpha-secret-value-1')
    expect(await betaStore.reveal('bank.token')).toBeNull()
    expect(await betaStore.list()).toEqual([])
  })

  it('binds ambient code to the tenant that started the work', async () => {
    const alpha = await fixture.registry.connect('alpha')
    const beta = await fixture.registry.connect('beta')

    const read = async (): Promise<string> => {
      const result = await currentDb().execute<{ entry: string }>(
        sql`select entry from ledger order by entry limit 1`,
      )
      return `${currentTenant().id}:${result.rows[0]?.entry ?? ''}`
    }

    const [a, b] = await Promise.all([
      runInTenantScope({ tenant: alpha.tenant, db: alpha.db, actor: null }, read),
      runInTenantScope({ tenant: beta.tenant, db: beta.db, actor: null }, read),
    ])

    expect(a).toBe('alpha:alpha-money')
    expect(b).toBe('beta:beta-money')
  })

  it('runs scheduled work against the right database for each tenant', async () => {
    const runner = new TenantJobRunner(fixture.controlPlane, fixture.registry)
    const seen: string[] = []

    await runner.runForAllTenants('isolation-probe', async () => {
      const result = await currentDb().execute<{ entry: string }>(
        sql`select entry from ledger order by entry limit 1`,
      )
      seen.push(`${currentTenant().id}:${result.rows[0]?.entry ?? ''}`)
    })

    expect(seen.sort()).toEqual(['alpha:alpha-money', 'beta:beta-money'])
  })

  it('migrates tenants independently', async () => {
    const fresh = await createTenantFixture(['solo'])
    try {
      await migrateTenant(fresh.registry.connectTo(fresh.tenant('solo')).db)
      expect((await readSchemaVersion(fresh.registry.connectTo(fresh.tenant('solo')).db)).upToDate).toBe(true)
      // The tenants in the other fixture are untouched by that migration run.
      expect(await entriesOf('alpha')).toContain('alpha-money')
    } finally {
      await fresh.dispose()
    }
  })

  it('never resolves one tenant’s host to another tenant', async () => {
    const alpha = await fixture.controlPlane.get('alpha')
    const beta = await fixture.controlPlane.get('beta')
    expect(alpha.hosts).not.toEqual(beta.hosts)
    expect(alpha.databaseUrl).not.toBe(beta.databaseUrl)
  })

  it('leaves no shared connection that could be reused across tenants', async () => {
    const alpha = await fixture.registry.connect('alpha')
    const beta = await fixture.registry.connect('beta')
    expect(alpha.pool).not.toBe(beta.pool)
  })
})
