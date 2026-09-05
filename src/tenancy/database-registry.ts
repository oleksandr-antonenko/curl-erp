import { Pool } from 'pg'
import { createDatabase, type Database } from '../db/client.js'
import type { ControlPlane } from './control-plane.js'
import { resolveDatabaseUrl, type TenantRecord } from './tenant.js'

export class TenantSuspendedError extends Error {
  override readonly name = 'TenantSuspendedError'
  constructor(readonly tenantId: string) {
    super(`Tenant "${tenantId}" is suspended`)
  }
}

export interface TenantConnection {
  readonly tenant: TenantRecord
  readonly db: Database
  readonly pool: Pool
}

export interface DatabaseRegistryOptions {
  /** Maximum pooled connections per tenant. */
  readonly maxConnectionsPerTenant?: number
  /** Idle timeout before a pooled connection is released, in milliseconds. */
  readonly idleTimeoutMillis?: number
  readonly connectionTimeoutMillis?: number
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Owns one connection pool per tenant database.
 *
 * An instance is constructed by the process that needs it and passed down; it
 * is never imported as a shared value. Pools are cached per tenant because
 * opening one per request would exhaust PostgreSQL long before the shop does.
 */
export class TenantDatabaseRegistry {
  private readonly pools = new Map<string, { pool: Pool; url: string }>()
  private closed = false

  constructor(
    private readonly controlPlane: ControlPlane,
    private readonly options: DatabaseRegistryOptions = {},
  ) {}

  /** Connects to a tenant by id, refusing suspended ones. */
  async connect(tenantId: string): Promise<TenantConnection> {
    const tenant = await this.controlPlane.get(tenantId)
    if (tenant.status !== 'active') throw new TenantSuspendedError(tenantId)
    return this.connectTo(tenant)
  }

  /** Connects to an already-loaded tenant record. */
  connectTo(tenant: TenantRecord): TenantConnection {
    if (this.closed) throw new Error('Database registry is closed')

    const url = resolveDatabaseUrl(tenant.databaseUrl, this.options.env ?? process.env)
    const cached = this.pools.get(tenant.id)

    // The connection string can change under us (rotated password, moved
    // database). Reusing the old pool would keep talking to the old target.
    if (cached !== undefined && cached.url === url) {
      return { tenant, db: createDatabase(cached.pool), pool: cached.pool }
    }
    if (cached !== undefined) void cached.pool.end()

    const pool = new Pool({
      connectionString: url,
      max: this.options.maxConnectionsPerTenant ?? 10,
      idleTimeoutMillis: this.options.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: this.options.connectionTimeoutMillis ?? 10_000,
      application_name: `erp:${tenant.id}`,
    })
    // Without a handler a dropped backend connection crashes the process.
    pool.on('error', () => undefined)

    this.pools.set(tenant.id, { pool, url })
    return { tenant, db: createDatabase(pool), pool }
  }

  /** Number of tenants with an open pool. Used by tests and health checks. */
  get openPools(): number {
    return this.pools.size
  }

  async closeTenant(tenantId: string): Promise<void> {
    const cached = this.pools.get(tenantId)
    if (cached === undefined) return
    this.pools.delete(tenantId)
    await cached.pool.end()
  }

  async close(): Promise<void> {
    this.closed = true
    const pools = [...this.pools.values()]
    this.pools.clear()
    await Promise.all(pools.map(async (entry) => entry.pool.end()))
  }
}
