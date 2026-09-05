import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TenantFixture } from '../testing/index.js'
import { createTenantFixture, pgToolRunner, testAdminUrl } from '../testing/index.js'
import { BackupError, backupTenant, type ProcessRunner, restoreTenant } from './backup.js'
import { migrateTenant } from './migrations.js'

describe('per-tenant backup and restore', () => {
  let fixture: TenantFixture
  let runner: ProcessRunner
  let directory: string

  beforeAll(async () => {
    fixture = await createTenantFixture(['alpha', 'beta'])
    runner = await pgToolRunner()
    directory = await mkdtemp(join(tmpdir(), 'erp-backup-'))

    for (const id of ['alpha', 'beta']) {
      const connection = fixture.registry.connectTo(fixture.tenant(id))
      await migrateTenant(connection.db)
      await connection.db.execute(sql`create table books (entry text not null)`)
      await connection.db.execute(sql`insert into books (entry) values (${`${id}-original`})`)
    }
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  const readBooks = async (id: string): Promise<string[]> => {
    const connection = await fixture.registry.connect(id)
    const result = await connection.db.execute<{ entry: string }>(sql`select entry from books order by entry`)
    return result.rows.map((row) => row.entry)
  }

  it('backs up one tenant to a file', async () => {
    const result = await backupTenant('alpha', {
      controlPlane: fixture.controlPlane,
      outputPath: join(directory, 'alpha.dump'),
      runner,
    })
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.tenantId).toBe('alpha')
  })

  it('restores that tenant and leaves every other tenant untouched', async () => {
    const outputPath = join(directory, 'alpha-restore.dump')
    await backupTenant('alpha', {
      controlPlane: fixture.controlPlane,
      outputPath,
      runner,
    })

    // Both tenants change after the backup was taken.
    const alpha = await fixture.registry.connect('alpha')
    await alpha.db.execute(sql`insert into books (entry) values ('alpha-after-backup')`)
    const beta = await fixture.registry.connect('beta')
    await beta.db.execute(sql`insert into books (entry) values ('beta-after-backup')`)

    expect(await readBooks('alpha')).toEqual(['alpha-after-backup', 'alpha-original'])

    await restoreTenant('alpha', {
      controlPlane: fixture.controlPlane,
      outputPath,
      runner,
      adminDatabaseUrl: testAdminUrl(),
      registry: fixture.registry,
      confirmTenantId: 'alpha',
    })

    expect(await readBooks('alpha')).toEqual(['alpha-original'])
    expect(await readBooks('beta')).toEqual(['beta-after-backup', 'beta-original'])
  })

  it('refuses to restore without confirming the tenant id', async () => {
    await expect(
      restoreTenant('alpha', {
        controlPlane: fixture.controlPlane,
        outputPath: join(directory, 'alpha.dump'),
        runner,
        adminDatabaseUrl: testAdminUrl(),
        confirmTenantId: 'beta',
      }),
    ).rejects.toThrow(BackupError)

    expect(await readBooks('beta')).toContain('beta-original')
  })

  it('reports a failed dump rather than a file nobody can restore', async () => {
    // A tenant whose database is gone: the dump must fail loudly, because a
    // backup believed to exist is worse than one known to be missing.
    await fixture.controlPlane.register({
      id: 'vanished',
      name: 'vanished',
      databaseUrl: fixture.tenant('alpha').databaseUrl.replace(/\/[^/]+$/, '/erp_no_such_database'),
    })

    await expect(
      backupTenant('vanished', {
        controlPlane: fixture.controlPlane,
        outputPath: join(directory, 'broken.dump'),
        runner,
      }),
    ).rejects.toThrow(BackupError)
  })

  it('refuses to call an empty dump a backup', async () => {
    const silentlyEmpty: ProcessRunner = {
      async run(_command, _args, options) {
        if (options?.stdoutPath !== undefined) await writeFile(options.stdoutPath, '')
        return { code: 0, stderr: '' }
      },
    }

    await expect(
      backupTenant('alpha', {
        controlPlane: fixture.controlPlane,
        outputPath: join(directory, 'empty.dump'),
        runner: silentlyEmpty,
      }),
    ).rejects.toThrow(/empty/)
  })
})
