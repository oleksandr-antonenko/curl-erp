import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import type { ControlPlane } from './control-plane.js'
import type { TenantDatabaseRegistry } from './database-registry.js'
import { createTenantDatabase, databaseNameFor, dropTenantDatabase } from './provisioning.js'
import { resolveDatabaseUrl } from './tenant.js'

export class BackupError extends Error {
  override readonly name = 'BackupError'
}

export interface ProcessResult {
  readonly code: number
  readonly stderr: string
}

/**
 * Runs an external command.
 *
 * Injectable because the PostgreSQL client tools are not always on the same
 * machine as the application - and because a test that mocks the dump proves
 * nothing about whether the dump can be restored.
 */
export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { readonly stdoutPath?: string; readonly stdinPath?: string },
  ): Promise<ProcessResult>
}

export class LocalProcessRunner implements ProcessRunner {
  async run(
    command: string,
    args: readonly string[],
    options: { readonly stdoutPath?: string; readonly stdinPath?: string } = {},
  ): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      const streams: Promise<unknown>[] = []
      if (options.stdoutPath !== undefined) {
        streams.push(pipeline(child.stdout, createWriteStream(options.stdoutPath)))
      } else {
        child.stdout.resume()
      }
      if (options.stdinPath !== undefined) {
        streams.push(pipeline(createReadStream(options.stdinPath), child.stdin))
      } else {
        child.stdin.end()
      }

      child.on('error', reject)
      child.on('close', (code) => {
        Promise.all(streams)
          .then(() => resolve({ code: code ?? 0, stderr }))
          .catch(reject)
      })
    })
  }
}

export interface BackupToolPaths {
  readonly pgDump?: string
  readonly pgRestore?: string
}

export interface BackupTenantOptions {
  readonly controlPlane: ControlPlane
  readonly outputPath: string
  readonly runner?: ProcessRunner
  readonly tools?: BackupToolPaths
  readonly env?: NodeJS.ProcessEnv
}

export interface BackupResult {
  readonly tenantId: string
  readonly path: string
  readonly bytes: number
}

/**
 * Dumps one tenant's database to a file.
 *
 * Per tenant rather than per cluster: restoring a whole cluster to recover one
 * customer's mistake would roll back every other customer with it.
 */
export async function backupTenant(tenantId: string, options: BackupTenantOptions): Promise<BackupResult> {
  const tenant = await options.controlPlane.get(tenantId)
  const url = resolveDatabaseUrl(tenant.databaseUrl, options.env ?? process.env)
  const runner = options.runner ?? new LocalProcessRunner()

  const result = await runner.run(
    options.tools?.pgDump ?? 'pg_dump',
    ['--format=custom', '--no-owner', '--no-privileges', '--dbname', url],
    { stdoutPath: options.outputPath },
  )

  if (result.code !== 0) {
    throw new BackupError(`pg_dump failed for tenant "${tenantId}": ${result.stderr.trim()}`)
  }

  const { size } = await stat(options.outputPath)
  if (size === 0) {
    throw new BackupError(`Backup of tenant "${tenantId}" is empty; refusing to report success`)
  }
  return { tenantId, path: options.outputPath, bytes: size }
}

export interface RestoreTenantOptions extends BackupTenantOptions {
  /** Maintenance connection, needed to recreate the database before loading. */
  readonly adminDatabaseUrl: string
  readonly registry?: TenantDatabaseRegistry
  /** Must equal the tenant id: restoring discards that tenant's current data. */
  readonly confirmTenantId: string
  readonly databaseName?: string
}

/**
 * Replaces one tenant's database with the contents of a backup.
 *
 * The database is dropped and recreated rather than restored over: leftovers
 * from the discarded state would silently survive into what everyone believes
 * is a clean restore.
 */
export async function restoreTenant(tenantId: string, options: RestoreTenantOptions): Promise<void> {
  if (options.confirmTenantId !== tenantId) {
    throw new BackupError('Restoring replaces the tenant’s data; confirm its id to proceed.')
  }

  const tenant = await options.controlPlane.get(tenantId)
  const url = resolveDatabaseUrl(tenant.databaseUrl, options.env ?? process.env)
  const databaseName = options.databaseName ?? new URL(url).pathname.replace(/^\//, '')
  if (databaseName === '') {
    throw new BackupError(`Cannot tell which database belongs to tenant "${tenantId}"`)
  }

  await options.registry?.closeTenant(tenantId)
  await dropTenantDatabase(options.adminDatabaseUrl, databaseName)
  await createTenantDatabase(options.adminDatabaseUrl, databaseName)

  const runner = options.runner ?? new LocalProcessRunner()
  const result = await runner.run(
    options.tools?.pgRestore ?? 'pg_restore',
    ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', url],
    { stdinPath: options.outputPath },
  )

  if (result.code !== 0) {
    throw new BackupError(`pg_restore failed for tenant "${tenantId}": ${result.stderr.trim()}`)
  }
}

export { databaseNameFor }
