import { runInTenantScope, type TenantScope } from './context.js'
import type { ControlPlane } from './control-plane.js'
import type { TenantDatabaseRegistry } from './database-registry.js'
import type { TenantRecord } from './tenant.js'

export type TenantJobStatus = 'ok' | 'failed' | 'skipped'

export interface TenantJobResult {
  readonly tenantId: string
  readonly status: TenantJobStatus
  readonly durationMs: number
  readonly error?: Error
  /** Why the tenant was skipped, when it was. */
  readonly reason?: string
}

export interface TenantJobReport {
  readonly job: string
  readonly startedAt: Date
  readonly durationMs: number
  readonly results: readonly TenantJobResult[]
  readonly succeeded: number
  readonly failed: number
  readonly skipped: number
}

/** A unit of scheduled work, run once per tenant with that tenant bound. */
export type TenantJob = (scope: TenantScope) => Promise<void>

export interface TenantJobRunnerOptions {
  /** Tenants processed at once. One by default: scheduled work is not urgent,
   * and a burst across every tenant is a good way to exhaust the database. */
  readonly concurrency?: number
  readonly onResult?: (result: TenantJobResult, job: string) => void
  readonly now?: () => number
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Runs scheduled work for every active tenant.
 *
 * The isolation matters more than the scheduling: one customer's broken data
 * must not stop the nightly run for everyone else, and the failure has to be
 * visible afterwards rather than only in a log line nobody reads.
 */
export class TenantJobRunner {
  constructor(
    private readonly controlPlane: ControlPlane,
    private readonly registry: TenantDatabaseRegistry,
    private readonly options: TenantJobRunnerOptions = {},
  ) {}

  private get clock(): () => number {
    return this.options.now ?? Date.now
  }

  /** Runs `job` for every active tenant, isolating failures. Never throws. */
  async runForAllTenants(name: string, job: TenantJob): Promise<TenantJobReport> {
    const startedAt = new Date()
    const startedMs = this.clock()
    const tenants = await this.controlPlane.list()

    const results: TenantJobResult[] = []
    const queue = [...tenants]
    const concurrency = Math.max(1, this.options.concurrency ?? 1)

    const worker = async (): Promise<void> => {
      for (;;) {
        const tenant = queue.shift()
        if (tenant === undefined) return
        results.push(await this.runOne(name, tenant, job))
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker))

    return {
      job: name,
      startedAt,
      durationMs: this.clock() - startedMs,
      results,
      succeeded: results.filter((result) => result.status === 'ok').length,
      failed: results.filter((result) => result.status === 'failed').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
    }
  }

  /** Runs `job` for one tenant. Never throws; the outcome is in the result. */
  async runForTenant(name: string, tenantId: string, job: TenantJob): Promise<TenantJobResult> {
    const tenant = await this.controlPlane.find(tenantId)
    if (tenant === null) {
      return this.record(name, {
        tenantId,
        status: 'skipped',
        durationMs: 0,
        reason: 'not registered',
      })
    }
    return this.runOne(name, tenant, job)
  }

  private async runOne(name: string, tenant: TenantRecord, job: TenantJob): Promise<TenantJobResult> {
    if (tenant.status !== 'active') {
      return this.record(name, {
        tenantId: tenant.id,
        status: 'skipped',
        durationMs: 0,
        reason: 'suspended',
      })
    }

    const startedMs = this.clock()
    try {
      const connection = this.registry.connectTo(tenant)
      await runInTenantScope({ tenant, db: connection.db, actor: null }, async () => {
        await job({ tenant, db: connection.db, actor: null })
      })
      return this.record(name, {
        tenantId: tenant.id,
        status: 'ok',
        durationMs: this.clock() - startedMs,
      })
    } catch (error) {
      return this.record(name, {
        tenantId: tenant.id,
        status: 'failed',
        durationMs: this.clock() - startedMs,
        error: toError(error),
      })
    }
  }

  private record(job: string, result: TenantJobResult): TenantJobResult {
    this.options.onResult?.(result, job)
    return result
  }
}
