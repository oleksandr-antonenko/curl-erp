import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { Pool, PoolClient } from 'pg'
import * as schema from './schema.js'

export type Schema = typeof schema

/** A handle on one tenant's database. Never a module-level value. */
export type Database = NodePgDatabase<Schema>

/** Creates a Drizzle handle over an existing pool. */
export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema })
}

/** Creates a Drizzle handle bound to a single checked-out connection. */
export function createDatabaseOnClient(client: PoolClient): Database {
  return drizzle(client, { schema })
}

export { schema }
