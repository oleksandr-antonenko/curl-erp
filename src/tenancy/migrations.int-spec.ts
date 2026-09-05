import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import {
  migrateAllTenants,
  migrateTenant,
  readRequiredMigrations,
  readSchemaVersion,
  reportSchemaVersions,
  SchemaOutOfDateError,
  SchemaVersionGuard,
} from './migrations.js'

describe('per-tenant migrations', () => {
  let fixture: TenantFixture

  beforeAll(async () => {
    fixture = await createTenantFixture(['alpha', 'beta'])
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  it('reports an unmigrated database as version zero rather than failing', async () => {
    const alpha = fixture.registry.connectTo(fixture.tenant('alpha'))
    const version = await readSchemaVersion(alpha.db)
    expect(version.applied).toBe(0)
    expect(version.required).toBeGreaterThan(0)
    expect(version.upToDate).toBe(false)
  })

  it('migrates a tenant and reports it up to date', async () => {
    const alpha = fixture.registry.connectTo(fixture.tenant('alpha'))
    const version = await migrateTenant(alpha.db)

    expect(version.upToDate).toBe(true)
    expect(version.applied).toBe((await readRequiredMigrations()).length)
    expect(version.lastAppliedAt).toBeInstanceOf(Date)

    const tables = await alpha.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    )
    expect(tables.rows.map((row) => row.table_name)).toContain('tenant_secrets')
  })

  it('is safe to run twice', async () => {
    const alpha = fixture.registry.connectTo(fixture.tenant('alpha'))
    const first = await readSchemaVersion(alpha.db)
    const second = await migrateTenant(alpha.db)
    expect(second.applied).toBe(first.applied)
  })

  it('migrates the rest of the estate when one tenant fails', async () => {
    const failing = await createTenantFixture(['broken', 'healthy'])
    try {
      // A table already occupying the name the migration wants to create.
      const broken = failing.registry.connectTo(failing.tenant('broken'))
      await broken.db.execute(sql`create table tenant_secrets (unrelated text)`)

      const report = await migrateAllTenants(failing.controlPlane, failing.registry)

      expect(report.failed).toBe(1)
      expect(report.migrated).toBe(1)

      const brokenResult = report.results.find((result) => result.tenantId === 'broken')
      const healthyResult = report.results.find((result) => result.tenantId === 'healthy')
      expect(brokenResult?.status).toBe('failed')
      expect(brokenResult?.error).toBeInstanceOf(Error)
      expect(healthyResult?.status).toBe('ok')
      expect(healthyResult?.version?.upToDate).toBe(true)

      const versions = await reportSchemaVersions(failing.controlPlane, failing.registry)
      const byTenant = new Map(versions.map((entry) => [entry.tenantId, entry]))
      expect(byTenant.get('healthy')?.version?.upToDate).toBe(true)
      expect(byTenant.get('broken')?.version?.upToDate).toBe(false)
    } finally {
      await failing.dispose()
    }
  })

  it('shows both states in one report', async () => {
    const versions = await reportSchemaVersions(fixture.controlPlane, fixture.registry)
    const byTenant = new Map(versions.map((entry) => [entry.tenantId, entry.version]))
    expect(byTenant.get('alpha')?.upToDate).toBe(true)
    expect(byTenant.get('beta')?.upToDate).toBe(false)
  })
})

describe('schema version guard', () => {
  let fixture: TenantFixture

  beforeAll(async () => {
    fixture = await createTenantFixture(['guarded'])
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  it('refuses an outdated tenant and admits it once migrated', async () => {
    const connection = fixture.registry.connectTo(fixture.tenant('guarded'))
    const guard = new SchemaVersionGuard({ recheckAfterMs: 0 })

    await expect(guard.assertUpToDate('guarded', connection.db)).rejects.toThrow(SchemaOutOfDateError)

    await migrateTenant(connection.db)
    await expect(guard.assertUpToDate('guarded', connection.db)).resolves.toBeUndefined()
  })

  it('holds a negative answer briefly instead of asking on every request', async () => {
    const other = await createTenantFixture(['cached'])
    try {
      const connection = other.registry.connectTo(other.tenant('cached'))
      let now = 1_000
      const guard = new SchemaVersionGuard({ recheckAfterMs: 5_000, now: () => now })

      await expect(guard.assertUpToDate('cached', connection.db)).rejects.toThrow(SchemaOutOfDateError)
      await migrateTenant(connection.db)

      // Still inside the window: the cached refusal stands.
      await expect(guard.assertUpToDate('cached', connection.db)).rejects.toThrow(SchemaOutOfDateError)

      now += 6_000
      await expect(guard.assertUpToDate('cached', connection.db)).resolves.toBeUndefined()
    } finally {
      await other.dispose()
    }
  })
})
