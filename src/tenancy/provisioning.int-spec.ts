import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testAdminUrl } from '../testing/index.js'
import { FileControlPlane } from './control-plane.js'
import { TenantDatabaseRegistry } from './database-registry.js'
import { readSchemaVersion } from './migrations.js'
import {
  activateTenant,
  databaseExists,
  databaseNameFor,
  deactivateTenant,
  deleteTenant,
  dropTenantDatabase,
  provisionTenant,
  TenantProvisioningError,
} from './provisioning.js'

describe('tenant provisioning', () => {
  let controlPlane: FileControlPlane
  let registry: TenantDatabaseRegistry
  const adminUrl = testAdminUrl()
  const provisioned: string[] = []

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'erp-prov-'))
    controlPlane = new FileControlPlane(join(dir, 'control-plane.json'))
    registry = new TenantDatabaseRegistry(controlPlane)
  })

  afterEach(async () => {
    await registry.close()
    for (const id of provisioned.splice(0)) {
      await dropTenantDatabase(adminUrl, databaseNameFor(id)).catch(() => undefined)
    }
  })

  const idFor = (suffix: string): string => {
    const id = `prov${Date.now().toString(36)}${suffix}`
    provisioned.push(id)
    return id
  }

  it('creates, migrates and registers in one operation', async () => {
    const id = idFor('a')
    const result = await provisionTenant({
      id,
      name: 'Provisioned',
      hosts: ['shop.example.com'],
      adminDatabaseUrl: adminUrl,
      controlPlane,
    })

    expect(result.tenant.id).toBe(id)
    expect(result.version.upToDate).toBe(true)
    expect(await databaseExists(adminUrl, result.databaseName)).toBe(true)
    expect((await controlPlane.get(id)).hosts).toEqual(['shop.example.com'])

    const connection = registry.connectTo(result.tenant)
    const version = await readSchemaVersion(connection.db)
    expect(version.upToDate).toBe(true)
  })

  it('leaves nothing behind when registration fails', async () => {
    const id = idFor('b')
    const databaseName = databaseNameFor(id)

    // A registry that accepts the database but refuses the final step.
    const failing = new Proxy(controlPlane, {
      get(target, property, receiver) {
        if (property === 'register') {
          return async (): Promise<never> => {
            throw new Error('control plane unavailable')
          }
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })

    await expect(provisionTenant({ id, adminDatabaseUrl: adminUrl, controlPlane: failing })).rejects.toThrow(
      TenantProvisioningError,
    )

    expect(await controlPlane.find(id)).toBeNull()
    expect(await databaseExists(adminUrl, databaseName)).toBe(false)

    // ...and the same call now succeeds, because nothing is in the way.
    const retried = await provisionTenant({ id, adminDatabaseUrl: adminUrl, controlPlane })
    expect(retried.tenant.id).toBe(id)
    expect(await databaseExists(adminUrl, databaseName)).toBe(true)
  })

  it('refuses to provision over an existing database', async () => {
    const id = idFor('c')
    await provisionTenant({ id, adminDatabaseUrl: adminUrl, controlPlane })
    await controlPlane.remove(id)

    await expect(provisionTenant({ id, adminDatabaseUrl: adminUrl, controlPlane })).rejects.toThrow(
      /already exists/,
    )
  })

  it('refuses to register the same tenant twice', async () => {
    const id = idFor('d')
    await provisionTenant({ id, adminDatabaseUrl: adminUrl, controlPlane })
    await expect(provisionTenant({ id, adminDatabaseUrl: adminUrl, controlPlane })).rejects.toThrow(
      /already registered/,
    )
  })

  it('keeps credentials out of the registry when asked', async () => {
    const id = idFor('e')
    const result = await provisionTenant({
      id,
      adminDatabaseUrl: adminUrl,
      controlPlane,
      storedDatabaseUrl: '${SOME_TENANT_DATABASE_URL}',
    })
    expect(result.tenant.databaseUrl).toBe('${SOME_TENANT_DATABASE_URL}')
    expect(result.tenant.databaseUrl).not.toContain('@')
  })
})

describe('deactivation', () => {
  let controlPlane: FileControlPlane
  let registry: TenantDatabaseRegistry
  const adminUrl = testAdminUrl()
  let id: string

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'erp-deact-'))
    controlPlane = new FileControlPlane(join(dir, 'control-plane.json'))
    registry = new TenantDatabaseRegistry(controlPlane)
    id = `deact${Date.now().toString(36)}`
    await provisionTenant({ id, adminDatabaseUrl: adminUrl, controlPlane })
  })

  afterEach(async () => {
    await registry.close()
    await dropTenantDatabase(adminUrl, databaseNameFor(id)).catch(() => undefined)
  })

  it('stops access immediately but keeps the data', async () => {
    const connection = registry.connectTo(await controlPlane.get(id))
    await connection.db.execute(sql`create table keepsake (value text)`)
    await connection.db.execute(sql`insert into keepsake values ('still here')`)

    await deactivateTenant(controlPlane, id, registry)

    expect((await controlPlane.get(id)).status).toBe('suspended')
    await expect(registry.connect(id)).rejects.toThrow()
    expect(await databaseExists(adminUrl, databaseNameFor(id))).toBe(true)

    await activateTenant(controlPlane, id)
    const again = await registry.connect(id)
    const rows = await again.db.execute(sql`select value from keepsake`)
    expect(rows.rows).toEqual([{ value: 'still here' }])
  })

  it('requires the tenant id to be confirmed before deleting anything', async () => {
    await expect(
      deleteTenant(id, {
        controlPlane,
        adminDatabaseUrl: adminUrl,
        confirmTenantId: 'something-else',
      }),
    ).rejects.toThrow(TenantProvisioningError)

    expect(await controlPlane.find(id)).not.toBeNull()
    expect(await databaseExists(adminUrl, databaseNameFor(id))).toBe(true)
  })

  it('deletes the tenant when the id is confirmed', async () => {
    await deleteTenant(id, {
      controlPlane,
      adminDatabaseUrl: adminUrl,
      registry,
      confirmTenantId: id,
    })

    expect(await controlPlane.find(id)).toBeNull()
    expect(await databaseExists(adminUrl, databaseNameFor(id))).toBe(false)
  })
})
