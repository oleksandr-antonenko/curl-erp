import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/client.js'
import { runInTenantScope } from '../tenancy/context.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { ChangeFeedReader, type ConsumerStatus, FeedConsumer, feedStatus, trimChangeFeed } from './feed.js'
import { journaled, recordChange } from './record.js'
import { changeEvents, feedConsumers, feedFailures } from './schema.js'
import type { ChangeEvent } from './types.js'

describe('change feed', () => {
  let fixture: TenantFixture
  let db: Database

  beforeAll(async () => {
    fixture = await createTenantFixture(['feed'], { migrate: true })
    db = fixture.registry.connectTo(fixture.tenant('feed')).db
    await db.execute(sql`create table feed_probe (id text primary key, title text not null)`)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.delete(feedFailures)
    await db.delete(feedConsumers)
    await db.delete(changeEvents)
    await db.execute(sql`delete from feed_probe`)
  })

  const emit = async (entityId: string, kind: 'created' | 'updated' | 'deleted' = 'updated') =>
    recordChange(db, { entityType: 'product', entityId, kind })

  describe('recording', () => {
    it('writes one event per change', async () => {
      const event = await emit('p1', 'created')
      expect(event.sequence).toBeGreaterThan(0)
      expect(event.entityType).toBe('product')
      expect(event.kind).toBe('created')

      const all = await new ChangeFeedReader(db).read(0)
      expect(all).toHaveLength(1)
    })

    it('leaves no event when the change is rolled back', async () => {
      await expect(
        journaled(db, async (tx, journal) => {
          await tx.execute(sql`insert into feed_probe (id, title) values ('p2', 'Shampoo')`)
          journal.record({ entityType: 'product', entityId: 'p2', kind: 'created' })
          throw new Error('changed my mind')
        }),
      ).rejects.toThrow('changed my mind')

      expect(await new ChangeFeedReader(db).read(0)).toEqual([])
      const probed = await db.execute(sql`select id from feed_probe`)
      expect(probed.rows).toEqual([])
    })

    it('keeps the change and its event together when it commits', async () => {
      await journaled(db, async (tx, journal) => {
        await tx.execute(sql`insert into feed_probe (id, title) values ('p3', 'Mask')`)
        journal.record({ entityType: 'product', entityId: 'p3', kind: 'created' })
      })

      const events = await new ChangeFeedReader(db).read(0)
      expect(events.map((event) => event.entityId)).toEqual(['p3'])
      const probed = await db.execute<{ id: string }>(sql`select id from feed_probe`)
      expect(probed.rows.map((row) => row.id)).toEqual(['p3'])
    })

    it('records who changed what, without recording the values', async () => {
      const alpha = fixture.registry.connectTo(fixture.tenant('feed'))
      await runInTenantScope(
        { tenant: alpha.tenant, db, actor: { type: 'human', id: 'staff-7', displayName: 'Ira' } },
        async () => {
          await recordChange(db, {
            entityType: 'variant',
            entityId: 'v9',
            kind: 'updated',
            changedFields: ['retailPrice'],
          })
        },
      )

      const [event] = await new ChangeFeedReader(db).read(0)
      expect(event?.actor).toEqual({ type: 'human', id: 'staff-7' })
      expect(event?.changedFields).toEqual(['retailPrice'])
      expect(JSON.stringify(event)).not.toContain('999')
    })

    it('numbers events in commit order for the same entity', async () => {
      const first = await emit('p4')
      const second = await emit('p4')
      expect(second.sequence).toBeGreaterThan(first.sequence)
    })
  })

  describe('consumers', () => {
    it('gives each consumer its own cursor', async () => {
      for (let i = 0; i < 3; i += 1) await emit(`p${i}`)

      const fast = new FeedConsumer(db, 'fast')
      const slow = new FeedConsumer(db, 'slow')

      const seenByFast: number[] = []
      await fast.drain(async (event) => {
        seenByFast.push(event.sequence)
      })

      expect(seenByFast).toHaveLength(3)
      expect(await slow.cursor()).toBe(0)

      const seenBySlow: number[] = []
      await slow.poll(async (event) => {
        seenBySlow.push(event.sequence)
      })
      expect(seenBySlow).toEqual(seenByFast)
    })

    it('redelivers an event the consumer died on', async () => {
      await emit('p1')
      const consumer = new FeedConsumer(db, 'flaky')

      let attempts = 0
      await consumer.poll(async () => {
        attempts += 1
        throw new Error('process died')
      })
      expect(await consumer.cursor()).toBe(0)

      await consumer.poll(async () => {
        attempts += 1
      })
      expect(attempts).toBe(2)
      expect(await consumer.cursor()).toBeGreaterThan(0)
    })

    it('delivers nothing twice once acknowledged', async () => {
      await emit('p1')
      await emit('p2')
      const consumer = new FeedConsumer(db, 'once')

      const seen: number[] = []
      await consumer.drain(async (event) => {
        seen.push(event.sequence)
      })
      await consumer.drain(async (event) => {
        seen.push(event.sequence)
      })

      expect(seen).toHaveLength(2)
      expect(new Set(seen).size).toBe(2)
    })

    it('skips work already acknowledged, for handlers that cannot repeat', async () => {
      await emit('p1')
      await emit('p2')
      const consumer = new FeedConsumer(db, 'notifier')

      const sent: number[] = []
      const send = async (event: ChangeEvent): Promise<void> => {
        sent.push(event.sequence)
      }

      await consumer.drain(async (event) => {
        await consumer.ifUnprocessed(event, send)
      })
      expect(sent).toHaveLength(2)

      // A redelivery of everything must not send anything a second time.
      const events = await new ChangeFeedReader(db).read(0)
      let repeated = 0
      for (const event of events) {
        if (await consumer.ifUnprocessed(event, send)) repeated += 1
      }

      expect(repeated).toBe(0)
      expect(sent).toHaveLength(2)
      expect(await consumer.hasProcessed(events[0]?.sequence ?? 0)).toBe(true)
    })

    it('lets a duplicate delivery be recognised by sequence number', async () => {
      await emit('p1')
      const consumer = new FeedConsumer(db, 'idempotent')
      const projection = new Map<number, ChangeEvent>()

      const handler = async (event: ChangeEvent): Promise<void> => {
        projection.set(event.sequence, event)
      }

      const [event] = await new ChangeFeedReader(db).read(0)
      if (event === undefined) throw new Error('expected an event')
      await handler(event)
      await handler(event)
      await consumer.drain(handler)

      expect(projection.size).toBe(1)
    })
  })

  describe('replay', () => {
    it('rebuilds one projection without disturbing another', async () => {
      for (let i = 0; i < 4; i += 1) await emit(`p${i}`)

      const index = new FeedConsumer(db, 'search-index')
      const channel = new FeedConsumer(db, 'channel-sync')
      await index.drain(async () => undefined)
      await channel.drain(async () => undefined)

      const channelCursor = await channel.cursor()
      expect(channelCursor).toBeGreaterThan(0)

      await index.resetTo(0)
      const replayed: number[] = []
      await index.drain(async (event) => {
        replayed.push(event.sequence)
      })

      expect(replayed).toHaveLength(4)
      expect(await channel.cursor()).toBe(channelCursor)
    })
  })

  describe('parking', () => {
    it('parks a poison event and keeps going', async () => {
      const bad = await emit('poison')
      const good = await emit('fine')

      const consumer = new FeedConsumer(db, 'parking', { maxAttempts: 2 })
      const processed: number[] = []

      const handler = async (event: ChangeEvent): Promise<void> => {
        if (event.sequence === bad.sequence) throw new Error('cannot handle this one')
        processed.push(event.sequence)
      }

      await consumer.poll(handler) // attempt 1 - stalls
      await consumer.drain(handler) // attempt 2 - parks, then continues

      expect(processed).toEqual([good.sequence])

      const parked = await consumer.parked()
      expect(parked).toHaveLength(1)
      expect(parked[0]?.eventId).toBe(bad.sequence)
      expect(parked[0]?.lastError).toBe('cannot handle this one')
      expect(parked[0]?.attempts).toBeGreaterThanOrEqual(2)
    })

    it('retries a parked event on request, without rewinding', async () => {
      const bad = await emit('poison')
      await emit('fine')

      const consumer = new FeedConsumer(db, 'retry', { maxAttempts: 1 })
      await consumer.drain(async (event) => {
        if (event.sequence === bad.sequence) throw new Error('nope')
      })

      const cursorBefore = await consumer.cursor()
      expect(await consumer.parked()).toHaveLength(1)

      const retried = await consumer.retryParked(async () => undefined)
      expect(retried).toBe(1)
      expect(await consumer.parked()).toHaveLength(0)
      expect(await consumer.cursor()).toBe(cursorBefore)
    })
  })

  describe('producers and consumers are independent', () => {
    it('accepts writes while no consumer is running', async () => {
      await expect(emit('p1')).resolves.toBeDefined()
      expect(await new ChangeFeedReader(db).head()).toBeGreaterThan(0)
      expect(await db.select().from(feedConsumers)).toEqual([])
    })
  })

  describe('observability', () => {
    it('reports lag, last acknowledgement and parked count', async () => {
      await emit('p1')
      await emit('p2')

      const consumer = new FeedConsumer(db, 'watched')
      await consumer.register()

      const before = await consumer.status()
      expect(before.lag).toBe(2)
      expect(before.lastAcknowledgedAt).toBeNull()

      await consumer.drain(async () => undefined)

      const after = await consumer.status()
      expect(after.lag).toBe(0)
      expect(after.cursor).toBe(after.head)
      expect(after.lastAcknowledgedAt).toBeInstanceOf(Date)
      expect(after.parked).toBe(0)
    })

    it('raises an alert once lag passes the threshold', async () => {
      const alerts: ConsumerStatus[] = []
      const consumer = new FeedConsumer(db, 'alerting', {
        lagAlertThreshold: 1,
        onLagAlert: (status) => alerts.push(status),
      })
      await consumer.register()

      await consumer.status()
      expect(alerts).toHaveLength(0)

      await emit('p1')
      await emit('p2')
      await consumer.status()

      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.consumer).toBe('alerting')
      expect(alerts[0]?.lag).toBe(2)
    })

    it('lists every consumer for a monitoring screen', async () => {
      await emit('p1')
      await new FeedConsumer(db, 'one').register()
      await new FeedConsumer(db, 'two').register()

      const statuses = await feedStatus(db)
      expect(statuses.map((status) => status.consumer).sort()).toEqual(['one', 'two'])
      expect(statuses.every((status) => status.lag === 1)).toBe(true)
    })
  })

  describe('history', () => {
    it('answers what happened to one entity', async () => {
      await emit('p1', 'created')
      await emit('p2', 'created')
      await emit('p1', 'updated')
      await emit('p1', 'deleted')

      const history = await new ChangeFeedReader(db).historyOf('product', 'p1')
      expect(history.map((event) => event.kind)).toEqual(['created', 'updated', 'deleted'])
      expect(history.every((event) => event.occurredAt instanceof Date)).toBe(true)
      expect(history[0]?.sequence).toBeLessThan(history[2]?.sequence ?? 0)
    })
  })

  describe('trimming', () => {
    it('refuses to remove events a consumer has not read', async () => {
      const first = await emit('p1')
      await emit('p2')
      await emit('p3')

      const lagging = new FeedConsumer(db, 'lagging')
      await lagging.register()
      await lagging.poll(async (event) => {
        if (event.sequence !== first.sequence) throw new Error('stop here')
      })

      const result = await trimChangeFeed(db, { before: new Date(Date.now() + 60_000) })

      expect(result.blockedBy?.consumer).toBe('lagging')
      expect(await new ChangeFeedReader(db).read(0)).toHaveLength(3 - result.deleted)
      expect(result.deleted).toBeLessThan(3)
    })

    it('removes events everyone has acknowledged', async () => {
      await emit('p1')
      await emit('p2')

      const consumer = new FeedConsumer(db, 'caught-up')
      await consumer.drain(async () => undefined)

      const result = await trimChangeFeed(db, { before: new Date(Date.now() + 60_000) })
      expect(result.deleted).toBe(2)
      expect(result.blockedBy).toBeUndefined()
    })

    it('keeps recent events even when everyone is caught up', async () => {
      await emit('p1')
      const consumer = new FeedConsumer(db, 'caught-up')
      await consumer.drain(async () => undefined)

      const result = await trimChangeFeed(db, { before: new Date(Date.now() - 60_000) })
      expect(result.deleted).toBe(0)
      expect(await new ChangeFeedReader(db).read(0)).toHaveLength(1)
    })
  })
})
