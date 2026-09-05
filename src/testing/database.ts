import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { loadTestEnv } from './env.js'

/**
 * Maintenance connection used to create and drop databases. Points at the
 * cluster's `postgres` database, never at a database holding real data.
 */
export function testAdminUrl(): string {
  loadTestEnv()
  const url = process.env['TEST_ADMIN_DATABASE_URL']
  if (url === undefined || url === '') {
    throw new Error('TEST_ADMIN_DATABASE_URL is not set. Run `npm run db:up`, or copy .env.example to .env.')
  }
  return url
}

/** Builds a connection URL for `database` on the same cluster as `adminUrl`. */
export function databaseUrlFor(adminUrl: string, database: string): string {
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  return url.toString()
}

export interface TemporaryDatabase {
  /** Physical database name, safe to interpolate: generated, never user input. */
  readonly name: string
  readonly url: string
  /** Drops the database. Safe to call twice. */
  drop(): Promise<void>
}

/**
 * Creates a throwaway database for one test file.
 *
 * A fresh database per test is slower than truncating tables, but it is the
 * only way to test tenancy honestly: the isolation tests must be able to hold
 * two real, separate databases at once.
 */
export async function createTemporaryDatabase(prefix = 'erp_test'): Promise<TemporaryDatabase> {
  const adminUrl = testAdminUrl()
  const name = `${prefix}_${randomBytes(8).toString('hex')}`

  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end()
  }

  let dropped = false
  return {
    name,
    url: databaseUrlFor(adminUrl, name),
    async drop(): Promise<void> {
      if (dropped) return
      dropped = true
      const client = new Client({ connectionString: adminUrl })
      await client.connect()
      try {
        // Sessions left open by a failed test would block DROP forever.
        await client.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [name],
        )
        await client.query(`DROP DATABASE IF EXISTS "${name}"`)
      } finally {
        await client.end()
      }
    },
  }
}

/** Creates a temporary database, runs `fn`, and always drops it afterwards. */
export async function withTemporaryDatabase<T>(
  fn: (database: TemporaryDatabase) => Promise<T>,
  prefix?: string,
): Promise<T> {
  const database = await createTemporaryDatabase(prefix)
  try {
    return await fn(database)
  } finally {
    await database.drop()
  }
}
