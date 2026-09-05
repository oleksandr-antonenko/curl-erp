import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

let loaded = false

/**
 * Loads `.env` from the repository root once per process.
 *
 * Tests must run on a machine where nobody has exported anything: defaults
 * point at the ports in docker-compose.dev.yml, so `npm run db:up` followed by
 * `npm run test:integration` is the whole setup.
 */
export function loadTestEnv(): void {
  if (loaded) return
  loaded = true

  // Walk up looking for the file: the package sits at a different depth once
  // it is extracted into a repository of its own.
  let directory = import.meta.dirname
  for (let depth = 0; depth < 6; depth += 1) {
    const envFile = resolve(directory, '.env')
    if (existsSync(envFile)) {
      process.loadEnvFile(envFile)
      break
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  process.env['TEST_ADMIN_DATABASE_URL'] ??= 'postgres://erp:erp@127.0.0.1:55432/postgres'
  process.env['REDIS_URL'] ??= 'redis://127.0.0.1:56379'
}
