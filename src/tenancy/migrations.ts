import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Database } from '../db/client.js'
import type { ControlPlane } from './control-plane.js'
import type { TenantDatabaseRegistry } from './database-registry.js'
import { type TenantJobResult, TenantJobRunner } from './jobs.js'

/**
 * Location of the generated SQL migrations.
 *
 * Resolved on call, not on import: a bundler rewrites modules without giving
 * them a directory, so a path computed at module load turns into a crash at
 * startup in any packaged build - and only there, which is the worst place to
 * find out.
 */
export function migrationsFolder(): string {
  const here = import.meta.dirname
  if (here === undefined || here === '') {
    throw new Error(
      'Cannot locate the migrations folder in this environment. ' +
        'Pass the folder explicitly to the migration functions.',
    )
  }
  // Same result from src and from dist: both are one level under the package.
  return resolve(here, '../../drizzle')
}

/**
 * Finds a PostgreSQL error code anywhere in the cause chain.
 *
 * The query layer wraps driver errors, so the code that says "this table does
 * not exist yet" is never on the error we catch.
 */
function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** The driver returns timestamps as strings for computed columns. */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[]
}

/** Migrations the running code expects, read from the generated journal. */
export async function readRequiredMigrations(folder?: string): Promise<readonly string[]> {
  const raw = await readFile(join(folder ?? migrationsFolder(), 'meta', '_journal.json'), 'utf8')
  const journal = JSON.parse(raw) as Journal
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag)
}

export interface SchemaVersion {
  /** Migrations already applied to this database. */
  readonly applied: number
  /** Migrations this build of the code ships. */
  readonly required: number
  readonly upToDate: boolean
  /** Set when the database has migrations the running code does not know about. */
  readonly ahead: boolean
  readonly lastAppliedAt: Date | null
}

/**
 * Reads how far a tenant database has been migrated.
 *
 * A database that has never been migrated is not an error here: reporting zero
 * lets an operator see the whole estate at once, which is the point of the
 * report.
 */
export async function readSchemaVersion(db: Database, folder?: string): Promise<SchemaVersion> {
  const required = (await readRequiredMigrations(folder)).length

  const result = await db
    .execute<{ count: string; last: unknown }>(sql`
    select
      coalesce(count(*), 0)::text as count,
      to_timestamp(max(created_at) / 1000.0) as last
    from drizzle."__drizzle_migrations"
  `)
    .catch((error: unknown) => {
      // Nothing applied yet: the bookkeeping table arrives with the first run.
      const code = postgresErrorCode(error)
      if (code === '42P01' || code === '3F000') return null
      throw error
    })

  const applied = result === null ? 0 : Number(result.rows[0]?.count ?? 0)
  const lastAppliedAt = result === null ? null : toDate(result.rows[0]?.last)

  return {
    applied,
    required,
    upToDate: applied >= required,
    ahead: applied > required,
    lastAppliedAt,
  }
}

export class SchemaOutOfDateError extends Error {
  override readonly name = 'SchemaOutOfDateError'
  constructor(
    readonly tenantId: string,
    readonly version: SchemaVersion,
  ) {
    super(
      `Tenant "${tenantId}" is at migration ${version.applied} of ${version.required}. ` +
        'Refusing to run against an outdated schema.',
    )
  }
}

/** Applies every pending migration to one tenant database. */
export async function migrateTenant(db: Database, folder?: string): Promise<SchemaVersion> {
  await migrate(db, { migrationsFolder: folder ?? migrationsFolder() })
  return readSchemaVersion(db, folder)
}

export interface TenantMigrationOutcome extends TenantJobResult {
  readonly version?: SchemaVersion
}

export interface MigrationReport {
  readonly results: readonly TenantMigrationOutcome[]
  readonly migrated: number
  readonly failed: number
  readonly skipped: number
}

/**
 * Migrates every tenant, independently.
 *
 * One customer's database being unreachable or holding a conflicting change
 * must not leave every other customer on the old schema - that turns a single
 * broken tenant into an outage for the whole estate.
 */
export async function migrateAllTenants(
  controlPlane: ControlPlane,
  registry: TenantDatabaseRegistry,
  folder?: string,
): Promise<MigrationReport> {
  const versions = new Map<string, SchemaVersion>()
  const runner = new TenantJobRunner(controlPlane, registry)

  const report = await runner.runForAllTenants('migrate', async ({ tenant, db }) => {
    versions.set(tenant.id, await migrateTenant(db, folder))
  })

  const results: TenantMigrationOutcome[] = report.results.map((result) => {
    const version = versions.get(result.tenantId)
    return version === undefined ? result : { ...result, version }
  })

  return {
    results,
    migrated: report.succeeded,
    failed: report.failed,
    skipped: report.skipped,
  }
}

/** Current schema version of every registered tenant, failures included. */
export async function reportSchemaVersions(
  controlPlane: ControlPlane,
  registry: TenantDatabaseRegistry,
  folder?: string,
): Promise<readonly { tenantId: string; version: SchemaVersion | null; error?: string }[]> {
  const tenants = await controlPlane.list()
  return Promise.all(
    tenants.map(async (tenant) => {
      try {
        const connection = registry.connectTo(tenant)
        return { tenantId: tenant.id, version: await readSchemaVersion(connection.db, folder) }
      } catch (error) {
        return { tenantId: tenant.id, version: null, error: (error as Error).message }
      }
    }),
  )
}

/**
 * Remembers which tenants are safe to serve.
 *
 * Checking on every request would add a round trip to each one; never checking
 * would let requests run against a schema the code does not match. So: an
 * up-to-date answer is kept for the life of the process, because a schema does
 * not go backwards, while a stale one is re-checked shortly after so service
 * resumes on its own once the migration lands.
 */
export class SchemaVersionGuard {
  private readonly upToDate = new Set<string>()
  private readonly behind = new Map<string, { at: number; version: SchemaVersion }>()

  constructor(
    private readonly options: {
      readonly recheckAfterMs?: number
      readonly folder?: string
      readonly now?: () => number
    } = {},
  ) {}

  /** Throws `SchemaOutOfDateError` when the tenant must not be served. */
  async assertUpToDate(tenantId: string, db: Database): Promise<void> {
    if (this.upToDate.has(tenantId)) return

    const now = (this.options.now ?? Date.now)()
    const cached = this.behind.get(tenantId)
    const recheckAfter = this.options.recheckAfterMs ?? 15_000
    if (cached !== undefined && now - cached.at < recheckAfter) {
      throw new SchemaOutOfDateError(tenantId, cached.version)
    }

    const version = await readSchemaVersion(db, this.options.folder)
    if (version.upToDate) {
      this.behind.delete(tenantId)
      this.upToDate.add(tenantId)
      return
    }

    this.behind.set(tenantId, { at: now, version })
    throw new SchemaOutOfDateError(tenantId, version)
  }

  /** Forgets what is known about a tenant, e.g. after migrating it. */
  invalidate(tenantId: string): void {
    this.upToDate.delete(tenantId)
    this.behind.delete(tenantId)
  }
}
