/**
 * The gap that silently loses events.
 *
 * Sequence numbers are assigned when a row is inserted, but rows become visible
 * when the transaction commits. A slow transaction can therefore commit event
 * 41 after a reader has already consumed event 42 - and nothing will ever
 * deliver 41. This is the test that says the journal does not do that.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/client.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { ChangeFeedReader, FeedConsumer } from './feed.js'
import { recordChange } from './record.js'
import { changeEvents, feedConsumers, feedFailures } from './schema.js'

describe('visibility horizon', () => {
  let fixture: TenantFixture
  let db: Database

  beforeAll(async () => {
    fixture = await createTenantFixture(['horizon'], { migrate: true })
    db = fixture.registry.connectTo(fixture.tenant('horizon')).db
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.delete(feedFailures)
    await db.delete(feedConsumers)
    await db.delete(changeEvents)
  })

  it('does not hand out an event that a later transaction can still slip under', async () => {
    const reader = new ChangeFeedReader(db)

    let releaseSlowWriter: (() => void) | undefined
    const slowWriterHasInserted = Promise.withResolvers<void>()
    const slowWriterFinished = Promise.withResolvers<void>()

    // Transaction A takes a low sequence number and stays open.
    const slowWriter = db
      .transaction(async (tx) => {
        await recordChange(tx, { entityType: 'product', entityId: 'early', kind: 'created' })
        slowWriterHasInserted.resolve()
        await new Promise<void>((resolve) => {
          releaseSlowWriter = resolve
        })
      })
      .then(() => slowWriterFinished.resolve())

    await slowWriterHasInserted.promise

    // Transaction B takes a higher number and commits immediately.
    const late = await recordChange(db, {
      entityType: 'product',
      entityId: 'late',
      kind: 'created',
    })

    // The later event is committed and visible, but reading it now would strand
    // the earlier one forever - so nothing may be delivered yet.
    const beforeCommit = await reader.read(0)
    expect(beforeCommit).toEqual([])

    releaseSlowWriter?.()
    await slowWriter
    await slowWriterFinished.promise

    const afterCommit = await reader.read(0)
    expect(afterCommit.map((event) => event.entityId)).toEqual(['early', 'late'])
    expect(afterCommit[0]?.sequence).toBeLessThan(late.sequence)
  })

  it('never lets a consumer skip past an event still in flight', async () => {
    const consumer = new FeedConsumer(db, 'horizon-consumer')
    const delivered: string[] = []

    const slowWriterHasInserted = Promise.withResolvers<void>()
    let releaseSlowWriter: (() => void) | undefined

    const slowWriter = db.transaction(async (tx) => {
      await recordChange(tx, { entityType: 'order', entityId: 'first', kind: 'created' })
      slowWriterHasInserted.resolve()
      await new Promise<void>((resolve) => {
        releaseSlowWriter = resolve
      })
    })

    await slowWriterHasInserted.promise
    await recordChange(db, { entityType: 'order', entityId: 'second', kind: 'created' })

    await consumer.drain(async (event) => {
      delivered.push(event.entityId)
    })
    expect(delivered).toEqual([])

    releaseSlowWriter?.()
    await slowWriter

    await consumer.drain(async (event) => {
      delivered.push(event.entityId)
    })
    expect(delivered).toEqual(['first', 'second'])
  })

  it('reports the head only up to the horizon', async () => {
    const reader = new ChangeFeedReader(db)
    const slowWriterHasInserted = Promise.withResolvers<void>()
    let releaseSlowWriter: (() => void) | undefined

    const slowWriter = db.transaction(async (tx) => {
      await recordChange(tx, { entityType: 'order', entityId: 'held', kind: 'created' })
      slowWriterHasInserted.resolve()
      await new Promise<void>((resolve) => {
        releaseSlowWriter = resolve
      })
    })

    await slowWriterHasInserted.promise
    await recordChange(db, { entityType: 'order', entityId: 'committed', kind: 'created' })

    expect(await reader.head()).toBe(0)
    expect(await reader.lagOf(0)).toBe(0)

    releaseSlowWriter?.()
    await slowWriter

    expect(await reader.head()).toBeGreaterThan(0)
    expect(await reader.lagOf(0)).toBe(2)
  })
})
