import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/client.js'
import { runInTenantScope } from '../tenancy/context.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { DocumentInUseError, Documents, IntegrityError } from './documents.js'
import type { DocumentStore } from './store.js'

/** A store that keeps bytes in memory and lets a test corrupt them. */
class FakeStore implements DocumentStore {
  readonly held = new Map<string, Uint8Array>()

  async put(input: { contentHash: string; content: Uint8Array }): Promise<string> {
    const location = `mem://${input.contentHash}`
    this.held.set(location, input.content)
    return location
  }

  async get(location: string): Promise<Uint8Array> {
    const content = this.held.get(location)
    if (content === undefined) throw new Error(`Nothing at ${location}`)
    return content
  }
}

const INVOICE = new TextEncoder().encode('Рахунок на оплату № 8872')

describe('documents', () => {
  let fixture: TenantFixture
  let db: Database
  let store: FakeStore
  let scoped: <T>(fn: () => Promise<T>) => Promise<T>

  beforeAll(async () => {
    fixture = await createTenantFixture(['documents'], { migrate: true })
    const tenant = fixture.tenant('documents')
    db = fixture.registry.connectTo(tenant).db
    scoped = (fn) => runInTenantScope({ tenant, db, actor: { type: 'human', id: 'staff-1' } }, fn)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(sql`truncate table documents restart identity cascade`)
    store = new FakeStore()
  })

  it('stores the same content once, however many times it is uploaded', async () => {
    const documents = new Documents(db, store)

    const first = await scoped(() => documents.put({ content: INVOICE, mediaType: 'text/plain' }))
    const second = await scoped(() => documents.put({ content: INVOICE, mediaType: 'text/plain' }))

    expect(first.isNew).toBe(true)
    expect(second.isNew).toBe(false)
    expect(second.id).toBe(first.id)
    // One row, and one copy of the bytes.
    expect(store.held.size).toBe(1)
    const rows = await db.execute<{ count: string }>(sql`select count(*) as count from documents`)
    expect(rows.rows[0]?.count).toBe('1')
  })

  it('reads content back unchanged', async () => {
    const documents = new Documents(db, store)
    const stored = await scoped(() => documents.put({ content: INVOICE, mediaType: 'text/plain' }))

    const read = await scoped(() => documents.read(stored.id))
    expect(new TextDecoder().decode(read)).toBe('Рахунок на оплату № 8872')
  })

  it('reports a mismatch instead of handing back bytes that were swapped', async () => {
    const documents = new Documents(db, store)
    const stored = await scoped(() => documents.put({ content: INVOICE, mediaType: 'text/plain' }))

    // Somebody replaced the evidence in the store.
    const [location] = [...store.held.keys()]
    if (location === undefined) throw new Error('nothing stored')
    store.held.set(location, new TextEncoder().encode('Рахунок на оплату № 1'))

    await expect(scoped(() => documents.read(stored.id))).rejects.toThrow(IntegrityError)
  })

  it('records who stored it, and refuses without an actor', async () => {
    const documents = new Documents(db, store)
    const tenant = fixture.tenant('documents')

    await expect(
      runInTenantScope({ tenant, db, actor: null }, () =>
        documents.put({ content: INVOICE, mediaType: 'text/plain' }),
      ),
    ).rejects.toThrow(/without an actor/)

    const stored = await scoped(() => documents.put({ content: INVOICE, mediaType: 'text/plain' }))
    const rows = await db.execute<{ actor_id: string; actor_type: string }>(
      sql`select actor_id, actor_type from documents where id = ${stored.id}`,
    )
    expect(rows.rows[0]?.actor_id).toBe('staff-1')
    expect(rows.rows[0]?.actor_type).toBe('human')
  })

  it('refuses to remove a document the books still cite, naming what holds it', async () => {
    const documents = new Documents(db, store, [{ heldBy: async () => 'supplier receipt 8872' }])
    const stored = await scoped(() => documents.put({ content: INVOICE, mediaType: 'text/plain' }))

    await expect(scoped(() => documents.remove(stored.id))).rejects.toThrow(DocumentInUseError)
    await expect(scoped(() => documents.remove(stored.id))).rejects.toThrow(/8872/)

    // Still there, and still readable.
    expect(await scoped(() => documents.find(stored.id))).not.toBeNull()
  })

  it('removes a document nothing cites', async () => {
    const documents = new Documents(db, store, [{ heldBy: async () => null }])
    const stored = await scoped(() => documents.put({ content: INVOICE, mediaType: 'text/plain' }))

    await scoped(() => documents.remove(stored.id))
    expect(await scoped(() => documents.find(stored.id))).toBeNull()
  })

  it('refuses an empty file as evidence', async () => {
    const documents = new Documents(db, store)
    await expect(
      scoped(() => documents.put({ content: new Uint8Array(), mediaType: 'text/plain' })),
    ).rejects.toThrow(/not evidence/)
  })

  it('keeps one tenant out of the other tenant documents', async () => {
    const other = await createTenantFixture(['other'], { migrate: true })
    try {
      const otherTenant = other.tenant('other')
      const otherDb = other.registry.connectTo(otherTenant).db
      const stored = await runInTenantScope(
        { tenant: otherTenant, db: otherDb, actor: { type: 'human', id: 'staff-2' } },
        () => new Documents(otherDb, new FakeStore()).put({ content: INVOICE, mediaType: 'text/plain' }),
      )

      // The same id, asked in our tenant, is simply not there.
      const here = await scoped(() => new Documents(db, store).find(stored.id))
      expect(here).toBeNull()
    } finally {
      await other.dispose()
    }
  })
})
