import { Client } from 'pg'
import type { ControlPlane } from './control-plane.js'
import { TenantDatabaseRegistry } from './database-registry.js'
import { migrateTenant, migrationsFolder, type SchemaVersion } from './migrations.js'
import { type TenantRecord, tenantIdSchema } from './tenant.js'

/** Physical database name for a tenant. Only characters safe as an identifier. */
export function databaseNameFor(tenantId: string): string {
  return `erp_${tenantId.replace(/-/g, '_')}`
}

/** Replaces the database in a maintenance URL, keeping credentials and host. */
function urlForDatabase(adminUrl: string, database: string): string {
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  return url.toString()
}

async function withAdminClient<T>(adminUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

export async function databaseExists(adminUrl: string, database: string): Promise<boolean> {
  return withAdminClient(adminUrl, async (client) => {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])
    return (result.rowCount ?? 0) > 0
  })
}

export async function createTenantDatabase(adminUrl: string, database: string): Promise<void> {
  await withAdminClient(adminUrl, async (client) => {
    await client.query(`CREATE DATABASE "${database}"`)
  })
}

export async function dropTenantDatabase(adminUrl: string, database: string): Promise<void> {
  await withAdminClient(adminUrl, async (client) => {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    )
    await client.query(`DROP DATABASE IF EXISTS "${database}"`)
  })
}

export class TenantProvisioningError extends Error {
  override readonly name = 'TenantProvisioningError'
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface ProvisionTenantOptions {
  readonly id: string
  readonly name?: string
  readonly hosts?: readonly string[]
  readonly entitlements?: readonly string[]
  /** Maintenance connection able to CREATE DATABASE. */
  readonly adminDatabaseUrl: string
  readonly controlPlane: ControlPlane
  /** Overrides the generated database name. */
  readonly databaseName?: string
  /**
   * Stored connection string. Defaults to the admin URL pointed at the new
   * database; pass `${ENV_VAR}` to keep credentials out of the registry file.
   */
  readonly storedDatabaseUrl?: string
  readonly migrationsFolder?: string
}

export interface ProvisionedTenant {
  readonly tenant: TenantRecord
  readonly databaseName: string
  readonly version: SchemaVersion
}

/**
 * Creates a tenant's database, migrates it and registers it - or leaves nothing
 * behind.
 *
 * A half-provisioned tenant is the worst outcome of the three: an unregistered
 * database is invisible to every tool that works from the registry, and a
 * registered tenant with no database fails on its first request instead of at
 * provisioning time, when somebody is still watching.
 */
export async function provisionTenant(options: ProvisionTenantOptions): Promise<ProvisionedTenant> {
  const id = tenantIdSchema.parse(options.id)
  const databaseName = options.databaseName ?? databaseNameFor(id)
  const folder = options.migrationsFolder ?? migrationsFolder()

  if (await options.controlPlane.find(id)) {
    throw new TenantProvisioningError(`Tenant "${id}" is already registered`)
  }
  if (await databaseExists(options.adminDatabaseUrl, databaseName)) {
    throw new TenantProvisioningError(
      `Database "${databaseName}" already exists. Provisioning refuses to adopt it: ` +
        'it may belong to another installation.',
    )
  }

  await createTenantDatabase(options.adminDatabaseUrl, databaseName)

  const connectUrl = urlForDatabase(options.adminDatabaseUrl, databaseName)
  const record: TenantRecord = {
    id,
    name: options.name ?? id,
    databaseUrl: options.storedDatabaseUrl ?? connectUrl,
    hosts: [...(options.hosts ?? [])],
    status: 'active',
    entitlements: [...(options.entitlements ?? [])],
  }

  let registered = false
  const registry = new TenantDatabaseRegistry(options.controlPlane)

  try {
    const connection = registry.connectTo({ ...record, databaseUrl: connectUrl })
    const version = await migrateTenant(connection.db, folder)
    await registry.close()

    const tenant = await options.controlPlane.register(record)
    registered = true

    return { tenant, databaseName, version }
  } catch (error) {
    await registry.close().catch(() => undefined)
    if (registered) {
      await options.controlPlane.remove(id).catch(() => undefined)
    }
    await dropTenantDatabase(options.adminDatabaseUrl, databaseName).catch(() => undefined)
    throw new TenantProvisioningError(
      `Provisioning tenant "${id}" failed and was rolled back: ${(error as Error).message}`,
      error,
    )
  }
}

/**
 * Stops all access to a tenant, keeping its data.
 *
 * Suspension and deletion are deliberately different operations: an unpaid
 * invoice and an ended contract are different situations, and only one of them
 * should ever be one command away from destroying a customer's books.
 */
export async function deactivateTenant(
  controlPlane: ControlPlane,
  tenantId: string,
  registry?: TenantDatabaseRegistry,
): Promise<TenantRecord> {
  const tenant = await controlPlane.update(tenantId, { status: 'suspended' })
  await registry?.closeTenant(tenantId)
  return tenant
}

export async function activateTenant(controlPlane: ControlPlane, tenantId: string): Promise<TenantRecord> {
  return controlPlane.update(tenantId, { status: 'active' })
}

export interface DeleteTenantOptions {
  readonly controlPlane: ControlPlane
  readonly adminDatabaseUrl: string
  readonly registry?: TenantDatabaseRegistry
  readonly databaseName?: string
  /** Must equal the tenant id. Guards against deleting the wrong customer. */
  readonly confirmTenantId: string
}

/** Removes a tenant and destroys its database. Irreversible. */
export async function deleteTenant(tenantId: string, options: DeleteTenantOptions): Promise<void> {
  if (options.confirmTenantId !== tenantId) {
    throw new TenantProvisioningError('Deleting a tenant requires confirming its id; nothing was deleted.')
  }

  const tenant = await options.controlPlane.get(tenantId)
  const databaseName = options.databaseName ?? databaseNameFor(tenant.id)

  await options.registry?.closeTenant(tenantId)
  await options.controlPlane.remove(tenantId)
  await dropTenantDatabase(options.adminDatabaseUrl, databaseName)
}
