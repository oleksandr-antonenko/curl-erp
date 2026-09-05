import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileControlPlane } from '../tenancy/control-plane.js'
import { TenantDatabaseRegistry } from '../tenancy/database-registry.js'
import { migrateTenant } from '../tenancy/migrations.js'
import type { TenantRecord } from '../tenancy/tenant.js'
import { createTemporaryDatabase, type TemporaryDatabase } from './database.js'

export interface TenantFixture {
  readonly controlPlane: FileControlPlane
  readonly registry: TenantDatabaseRegistry
  readonly tenants: readonly TenantRecord[]
  readonly databases: readonly TemporaryDatabase[]
  tenant(id: string): TenantRecord
  dispose(): Promise<void>
}

/**
 * Spins up real, separate databases for the given tenant ids.
 *
 * Isolation cannot be tested against mocks: the claim is that one tenant's
 * query cannot reach another's rows, and only two actual databases can show
 * that.
 */
export interface TenantFixtureSpec {
  readonly id: string
  readonly hosts?: readonly string[]
}

export interface TenantFixtureOptions {
  /** Applies every migration to each tenant, as a real installation would. */
  readonly migrate?: boolean
}

export async function createTenantFixture(
  specs: readonly (string | TenantFixtureSpec)[],
  options: TenantFixtureOptions = {},
): Promise<TenantFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'erp-tenants-'))
  const controlPlane = new FileControlPlane(join(dir, 'control-plane.json'))

  const databases: TemporaryDatabase[] = []
  const tenants: TenantRecord[] = []

  try {
    for (const spec of specs) {
      const { id, hosts } = typeof spec === 'string' ? { id: spec, hosts: [] } : spec
      const database = await createTemporaryDatabase(`erp_${id}`)
      databases.push(database)
      tenants.push(
        await controlPlane.register({
          id,
          name: id,
          databaseUrl: database.url,
          hosts: [...(hosts ?? [])],
        }),
      )
    }
  } catch (error) {
    await Promise.all(databases.map(async (database) => database.drop()))
    throw error
  }

  const registry = new TenantDatabaseRegistry(controlPlane)

  if (options.migrate === true) {
    for (const tenant of tenants) {
      await migrateTenant(registry.connectTo(tenant).db)
    }
  }

  return {
    controlPlane,
    registry,
    tenants,
    databases,
    tenant(id: string): TenantRecord {
      const found = tenants.find((tenant) => tenant.id === id)
      if (found === undefined) throw new Error(`Fixture has no tenant "${id}"`)
      return found
    },
    async dispose(): Promise<void> {
      await registry.close()
      await Promise.all(databases.map(async (database) => database.drop()))
    },
  }
}
