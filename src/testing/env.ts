import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

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

  const root = resolve(import.meta.dirname, '../../../..')
  const envFile = resolve(root, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)

  process.env['TEST_ADMIN_DATABASE_URL'] ??= 'postgres://erp:erp@127.0.0.1:55432/postgres'
  process.env['REDIS_URL'] ??= 'redis://127.0.0.1:56379'
}
