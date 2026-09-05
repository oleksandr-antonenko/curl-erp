import { and, asc, count, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { toChangeEvent } from './record.js'
import { changeEvents, feedConsumers, feedFailures } from './schema.js'
import type { ChangeEvent } from './types.js'

/**
 * Only events from transactions that have finished.
 *
 * Sequence numbers are handed out on insert but rows appear on commit, so a
 * long transaction can commit event 41 after a reader has already taken event
 * 42. Reading below the snapshot's horizon removes that hole entirely: nothing
 * can still arrive underneath the cursor.
 */
const SETTLED = sql`${changeEvents.xactId} < pg_snapshot_xmin(pg_current_snapshot())`

export interface ReadOptions {
  readonly limit?: number
}

/** Read access to the journal, independent of any consumer. */
export class ChangeFeedReader {
  constructor(private readonly db: Database) {}

  /** Settled events after `cursor`, in sequence order. */
  async read(cursor: number, options: ReadOptions = {}): Promise<ChangeEvent[]> {
    const rows = await this.db
      .select()
      .from(changeEvents)
      .where(and(gt(changeEvents.id, cursor), SETTLED))
      .orderBy(asc(changeEvents.id))
      .limit(options.limit ?? 100)
    return rows.map(toChangeEvent)
  }

  /** Highest settled sequence number, or 0 when the journal is empty. */
  async head(): Promise<number> {
    const result = await this.db.execute<{ head: string | null }>(
      sql`select max(${changeEvents.id})::text as head from ${changeEvents} where ${SETTLED}`,
    )
    return Number(result.rows[0]?.head ?? 0)
  }

  /** Everything that ever happened to one entity, oldest first. */
  async historyOf(entityType: string, entityId: string): Promise<ChangeEvent[]> {
    const rows = await this.db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.entityType, entityType), eq(changeEvents.entityId, entityId)))
      .orderBy(asc(changeEvents.id))
    return rows.map(toChangeEvent)
  }

  /** How far behind the head a given cursor is. */
  async lagOf(cursor: number): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(changeEvents)
      .where(and(gt(changeEvents.id, cursor), SETTLED))
    return row?.value ?? 0
  }
}

export interface TrimOptions {
  /** Remove events that occurred before this moment. */
  readonly before: Date
}

export interface TrimResult {
  readonly deleted: number
  /** Set when a consumer's cursor stopped the trim short. */
  readonly blockedBy?: { readonly consumer: string; readonly cursor: number }
}

/**
 * Deletes old events, never past a consumer that has not read them.
 *
 * The journal is what makes a projection rebuildable, so trimming is an
 * explicit administrative act - and one that must not quietly destroy the work
 * a lagging consumer still has to do.
 */
export async function trimChangeFeed(db: Database, options: TrimOptions): Promise<TrimResult> {
  const consumers = await db.select().from(feedConsumers)

  const slowest = consumers.reduce<{ consumer: string; cursor: number } | null>(
    (lowest, row) =>
      lowest === null || row.cursor < lowest.cursor ? { consumer: row.name, cursor: row.cursor } : lowest,
    null,
  )

  // With no consumers registered nothing has a claim on the journal.
  const safeUpTo = slowest?.cursor ?? Number.MAX_SAFE_INTEGER

  const deleted = await db
    .delete(changeEvents)
    .where(and(lte(changeEvents.id, safeUpTo), sql`${changeEvents.occurredAt} < ${options.before}`))
    .returning({ id: changeEvents.id })

  const wouldHaveDeletedMore = await db
    .select({ value: count() })
    .from(changeEvents)
    .where(and(gt(changeEvents.id, safeUpTo), sql`${changeEvents.occurredAt} < ${options.before}`))

  const blocked = (wouldHaveDeletedMore[0]?.value ?? 0) > 0 && slowest !== null

  return {
    deleted: deleted.length,
    ...(blocked && slowest !== null ? { blockedBy: slowest } : {}),
  }
}

export interface ParkedEvent {
  readonly eventId: number
  readonly attempts: number
  readonly lastError: string | null
  readonly firstFailedAt: Date
  readonly parkedAt: Date
}

export interface ConsumerStatus {
  readonly consumer: string
  readonly cursor: number
  readonly head: number
  /** Settled events waiting for this consumer. */
  readonly lag: number
  readonly lastAcknowledgedAt: Date | null
  readonly parked: number
}

export interface PollResult {
  readonly delivered: number
  readonly failed: number
  readonly parked: number
  readonly cursor: number
  /** True when the batch stopped early because an event kept failing. */
  readonly stalled: boolean
}

export interface ConsumerOptions {
  readonly batchSize?: number
  /** Attempts on one event before it is parked and the consumer moves on. */
  readonly maxAttempts?: number
  /** Lag above which `onLagAlert` fires. */
  readonly lagAlertThreshold?: number
  readonly onLagAlert?: (status: ConsumerStatus) => void
  readonly now?: () => Date
}

export type ChangeHandler = (event: ChangeEvent) => Promise<void>

/**
 * One consumer's position in the journal.
 *
 * Each consumer owns its cursor, so a rebuild of the search index cannot
 * disturb channel synchronisation, and a channel being down cannot stop the
 * marketplace feeds.
 */
export class FeedConsumer {
  private readonly reader: ChangeFeedReader

  constructor(
    private readonly db: Database,
    readonly name: string,
    private readonly options: ConsumerOptions = {},
  ) {
    this.reader = new ChangeFeedReader(db)
  }

  private get clock(): () => Date {
    return this.options.now ?? ((): Date => new Date())
  }

  /** Creates the consumer's cursor if this is its first run. */
  async register(startAt = 0): Promise<void> {
    await this.db.insert(feedConsumers).values({ name: this.name, cursor: startAt }).onConflictDoNothing()
  }

  async cursor(): Promise<number> {
    const [row] = await this.db
      .select({ cursor: feedConsumers.cursor })
      .from(feedConsumers)
      .where(eq(feedConsumers.name, this.name))
      .limit(1)
    return row?.cursor ?? 0
  }

  private async setCursor(value: number, acknowledged: boolean): Promise<void> {
    const now = this.clock()
    await this.db
      .insert(feedConsumers)
      .values({
        name: this.name,
        cursor: value,
        updatedAt: now,
        lastAcknowledgedAt: acknowledged ? now : null,
      })
      .onConflictDoUpdate({
        target: feedConsumers.name,
        set: {
          cursor: value,
          updatedAt: now,
          ...(acknowledged ? { lastAcknowledgedAt: now } : {}),
        },
      })
  }

  /**
   * Rewinds or fast-forwards this consumer only.
   *
   * Rebuilding a projection is a normal operation, not a disaster recovery
   * step, so it must not require touching anyone else's progress.
   */
  async resetTo(sequence: number): Promise<void> {
    await this.setCursor(sequence, false)
    await this.db.delete(feedFailures).where(eq(feedFailures.consumer, this.name))
  }

  /**
   * Whether this consumer has already acknowledged an event.
   *
   * The cursor is the answer, so deduplication needs no second table: anything
   * at or below it has been processed and acknowledged, and delivery is
   * at-least-once precisely because the cursor moves after the handler, not
   * before.
   */
  async hasProcessed(sequence: number): Promise<boolean> {
    return sequence <= (await this.cursor())
  }

  /**
   * Runs `fn` unless this event was already acknowledged.
   *
   * For handlers whose effect is not naturally repeatable - sending a message,
   * charging a card - where a redelivery would otherwise do it twice.
   */
  async ifUnprocessed(event: ChangeEvent, fn: ChangeHandler): Promise<boolean> {
    if (await this.hasProcessed(event.sequence)) return false
    await fn(event)
    return true
  }

  async status(): Promise<ConsumerStatus> {
    const cursor = await this.cursor()
    const [head, lag, parked] = await Promise.all([
      this.reader.head(),
      this.reader.lagOf(cursor),
      this.parkedCount(),
    ])
    const [row] = await this.db
      .select({ at: feedConsumers.lastAcknowledgedAt })
      .from(feedConsumers)
      .where(eq(feedConsumers.name, this.name))
      .limit(1)

    const status: ConsumerStatus = {
      consumer: this.name,
      cursor,
      head,
      lag,
      lastAcknowledgedAt: row?.at ?? null,
      parked,
    }

    const threshold = this.options.lagAlertThreshold
    if (threshold !== undefined && lag > threshold) this.options.onLagAlert?.(status)

    return status
  }

  private async parkedCount(): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(feedFailures)
      .where(and(eq(feedFailures.consumer, this.name), isNotNull(feedFailures.parkedAt)))
    return row?.value ?? 0
  }

  async parked(): Promise<ParkedEvent[]> {
    const rows = await this.db
      .select()
      .from(feedFailures)
      .where(and(eq(feedFailures.consumer, this.name), isNotNull(feedFailures.parkedAt)))
      .orderBy(asc(feedFailures.eventId))

    return rows.flatMap((row) =>
      row.parkedAt === null
        ? []
        : [
            {
              eventId: row.eventId,
              attempts: row.attempts,
              lastError: row.lastError,
              firstFailedAt: row.firstFailedAt,
              parkedAt: row.parkedAt,
            },
          ],
    )
  }

  /**
   * Re-runs a parked event without rewinding the cursor.
   *
   * The usual case is one bad row among thousands: an operator fixes the data
   * and wants that row processed, not the whole journal replayed.
   */
  async retryParked(handler: ChangeHandler, eventId?: number): Promise<number> {
    const parked = await this.parked()
    const wanted = eventId === undefined ? parked : parked.filter((e) => e.eventId === eventId)

    let processed = 0
    for (const entry of wanted) {
      const [row] = await this.db
        .select()
        .from(changeEvents)
        .where(eq(changeEvents.id, entry.eventId))
        .limit(1)
      // The event may have been trimmed away; drop the record with it.
      if (row === undefined) {
        await this.clearFailure(entry.eventId)
        continue
      }

      try {
        await handler(toChangeEvent(row))
        await this.clearFailure(entry.eventId)
        processed += 1
      } catch (error) {
        await this.db
          .update(feedFailures)
          .set({ lastError: (error as Error).message })
          .where(and(eq(feedFailures.consumer, this.name), eq(feedFailures.eventId, entry.eventId)))
      }
    }
    return processed
  }

  private async clearFailure(eventId: number): Promise<void> {
    await this.db
      .delete(feedFailures)
      .where(and(eq(feedFailures.consumer, this.name), eq(feedFailures.eventId, eventId)))
  }

  private async recordFailure(eventId: number, error: Error): Promise<number> {
    const maxAttempts = this.options.maxAttempts ?? 3
    const [row] = await this.db
      .insert(feedFailures)
      .values({ consumer: this.name, eventId, attempts: 1, lastError: error.message })
      .onConflictDoUpdate({
        target: [feedFailures.consumer, feedFailures.eventId],
        set: { attempts: sql`${feedFailures.attempts} + 1`, lastError: error.message },
      })
      .returning({ attempts: feedFailures.attempts })

    const attempts = row?.attempts ?? 1
    if (attempts >= maxAttempts) {
      await this.db
        .update(feedFailures)
        .set({ parkedAt: this.clock() })
        .where(and(eq(feedFailures.consumer, this.name), eq(feedFailures.eventId, eventId)))
    }
    return attempts
  }

  /**
   * Delivers the next batch.
   *
   * The cursor advances only after the handler returns, so a consumer that dies
   * mid-event sees it again. Handlers must therefore be idempotent - the
   * sequence number is on every event for exactly that purpose.
   */
  async poll(handler: ChangeHandler): Promise<PollResult> {
    await this.register()
    const maxAttempts = this.options.maxAttempts ?? 3
    let cursor = await this.cursor()
    const events = await this.reader.read(cursor, { limit: this.options.batchSize ?? 100 })

    let delivered = 0
    let failed = 0
    let parked = 0
    let stalled = false

    for (const event of events) {
      try {
        await handler(event)
        await this.clearFailure(event.sequence)
        cursor = event.sequence
        await this.setCursor(cursor, true)
        delivered += 1
      } catch (error) {
        failed += 1
        const attempts = await this.recordFailure(event.sequence, error as Error)
        if (attempts >= maxAttempts) {
          // Give up on this one and keep the rest of the journal moving.
          parked += 1
          cursor = event.sequence
          await this.setCursor(cursor, false)
          continue
        }
        stalled = true
        break
      }
    }

    if (this.options.lagAlertThreshold !== undefined) await this.status()

    return { delivered, failed, parked, cursor, stalled }
  }

  /** Keeps polling until the journal is drained or a batch stalls. */
  async drain(handler: ChangeHandler): Promise<PollResult> {
    let total: PollResult = { delivered: 0, failed: 0, parked: 0, cursor: 0, stalled: false }
    for (;;) {
      const result = await this.poll(handler)
      total = {
        delivered: total.delivered + result.delivered,
        failed: total.failed + result.failed,
        parked: total.parked + result.parked,
        cursor: result.cursor,
        stalled: result.stalled,
      }
      if (result.delivered + result.parked === 0 || result.stalled) return total
    }
  }
}

/** Status of every registered consumer, for a monitoring screen. */
export async function feedStatus(db: Database): Promise<ConsumerStatus[]> {
  const rows = await db.select({ name: feedConsumers.name }).from(feedConsumers)
  return Promise.all(rows.map(async (row) => new FeedConsumer(db, row.name).status()))
}

export { isNull }
