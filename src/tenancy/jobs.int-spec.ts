import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { currentDb, currentTenant } from './context.js'
import { type TenantJobResult, TenantJobRunner } from './jobs.js'

describe('scheduled work across tenants', () => {
  let fixture: TenantFixture

  beforeAll(async () => {
    fixture = await createTenantFixture(['alpha', 'beta', 'gamma'])
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  it('runs once per tenant, each bound to its own database', async () => {
    const runner = new TenantJobRunner(fixture.controlPlane, fixture.registry)
    const seen: string[] = []

    const report = await runner.runForAllTenants('collect', async () => {
      const result = await currentDb().execute(sql`select current_database() as name`)
      seen.push(`${currentTenant().id}:${(result.rows[0] as { name: string }).name}`)
    })

    expect(report.succeeded).toBe(3)
    expect(report.failed).toBe(0)
    expect(seen).toHaveLength(3)
    for (const entry of seen) {
      const [tenantId, database] = entry.split(':')
      expect(database).toContain(tenantId as string)
    }
  })

  it('keeps running for other tenants after one fails, and records the failure', async () => {
    const runner = new TenantJobRunner(fixture.controlPlane, fixture.registry)
    const completed: string[] = []

    const report = await runner.runForAllTenants('fragile', async ({ tenant }) => {
      if (tenant.id === 'alpha') throw new Error('alpha data is broken')
      completed.push(tenant.id)
    })

    expect(completed.sort()).toEqual(['beta', 'gamma'])
    expect(report.succeeded).toBe(2)
    expect(report.failed).toBe(1)

    const failure = report.results.find((result) => result.tenantId === 'alpha')
    expect(failure?.status).toBe('failed')
    expect(failure?.error?.message).toBe('alpha data is broken')
  })

  it('does not throw out of the run', async () => {
    const runner = new TenantJobRunner(fixture.controlPlane, fixture.registry)
    await expect(
      runner.runForAllTenants('always-fails', async () => {
        throw new Error('boom')
      }),
    ).resolves.toMatchObject({ failed: 3, succeeded: 0 })
  })

  it('skips a suspended tenant without touching its database', async () => {
    await fixture.controlPlane.update('gamma', { status: 'suspended' })
    const runner = new TenantJobRunner(fixture.controlPlane, fixture.registry)

    const report = await runner.runForAllTenants('collect', async () => {
      await currentDb().execute(sql`select 1`)
    })
    await fixture.controlPlane.update('gamma', { status: 'active' })

    expect(report.skipped).toBe(1)
    expect(report.succeeded).toBe(2)
    expect(report.results.find((r) => r.tenantId === 'gamma')?.reason).toBe('suspended')
  })

  it('reports every outcome as it happens', async () => {
    const observed: TenantJobResult[] = []
    const runner = new TenantJobRunner(fixture.controlPlane, fixture.registry, {
      onResult: (result) => observed.push(result),
    })

    await runner.runForAllTenants('watched', async ({ tenant }) => {
      if (tenant.id === 'beta') throw new Error('nope')
    })

    expect(observed).toHaveLength(3)
    expect(observed.filter((result) => result.status === 'failed')).toHaveLength(1)
  })

  it('runs a single tenant on demand and skips an unregistered one', async () => {
    const runner = new TenantJobRunner(fixture.controlPlane, fixture.registry)

    const ok = await runner.runForTenant('one', 'alpha', async () => {
      await currentDb().execute(sql`select 1`)
    })
    expect(ok.status).toBe('ok')

    const missing = await runner.runForTenant('one', 'nowhere', async () => undefined)
    expect(missing).toMatchObject({ status: 'skipped', reason: 'not registered' })
  })

  it('processes tenants in parallel when asked to', async () => {
    const runner = new TenantJobRunner(fixture.controlPlane, fixture.registry, { concurrency: 3 })
    let inFlight = 0
    let peak = 0

    await runner.runForAllTenants('parallel', async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight -= 1
    })

    expect(peak).toBeGreaterThan(1)
  })
})
