import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { createTemporaryDatabase, withTemporaryDatabase } from './index.js'

describe('development stack', () => {
  it('gives each test its own database', async () => {
    const first = await createTemporaryDatabase()
    const second = await createTemporaryDatabase()
    try {
      expect(first.name).not.toBe(second.name)

      const client = new Client({ connectionString: first.url })
      await client.connect()
      try {
        const result = await client.query<{ name: string }>('SELECT current_database() AS name')
        expect(result.rows[0]?.name).toBe(first.name)
      } finally {
        await client.end()
      }
    } finally {
      await first.drop()
      await second.drop()
    }
  })

  it('drops the database afterwards', async () => {
    const database = await createTemporaryDatabase()
    const name = database.name
    await database.drop()
    await database.drop() // idempotent

    await withTemporaryDatabase(async (admin) => {
      const client = new Client({ connectionString: admin.url })
      await client.connect()
      try {
        const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
        expect(result.rowCount).toBe(0)
      } finally {
        await client.end()
      }
    })
  })

  it('provides the extensions the core relies on', async () => {
    await withTemporaryDatabase(async (database) => {
      const client = new Client({ connectionString: database.url })
      await client.connect()
      try {
        const result = await client.query<{ name: string }>(
          "SELECT name FROM pg_available_extensions WHERE name IN ('vector', 'pg_trgm', 'unaccent')",
        )
        const names = result.rows.map((row) => row.name).sort()
        expect(names).toEqual(['pg_trgm', 'unaccent', 'vector'])
      } finally {
        await client.end()
      }
    })
  })
})
