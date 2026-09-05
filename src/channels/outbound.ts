import { and, asc, count, eq, lte, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { channelOutbound } from './schema.js'

export type OutboundKind = 'product' | 'unpublish' | 'stock' | 'price' | 'order_status'

export interface OutboundItem {
  readonly id: string
  readonly channel: string
  readonly kind: OutboundKind
  readonly subject: string
  readonly payload: Record<string, unknown>
  readonly attempts: number
  readonly lastError: string | null
  readonly createdAt: Date
}

export interface OutboundStatus {
  readonly channel: string
  readonly pending: number
  /** How long the oldest waiting item has been waiting, in milliseconds. */
  readonly oldestAgeMs: number | null
  readonly failing: number
}

export interface DispatchResult {
  readonly sent: number
  readonly failed: number
  readonly remaining: number
}

export interface OutboundOptions {
  readonly batchSize?: number
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  readonly now?: () => Date
}

/**
 * Work owed to a channel.
 *
 * A channel being down must never stop the core: the shop keeps taking stock
 * receipts and price changes, and the channel finds out when it comes back.
 * Items are keyed by subject, so a hundred price changes to one variant during
 * an outage arrive as the final price rather than as a hundred requests.
 */
export class ChannelOutbound {
  constructor(
    private readonly db: Database,
    private readonly options: OutboundOptions = {},
  ) {}

  private get clock(): () => Date {
    return this.options.now ?? ((): Date => new Date())
  }

  /** Queues an item, replacing any earlier one about the same subject. */
  async enqueue(
    channel: string,
    kind: OutboundKind,
    subject: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const now = this.clock()
    await this.db
      .insert(channelOutbound)
      .values({ channel, kind, subject, payload, availableAt: now })
      .onConflictDoUpdate({
        target: [channelOutbound.channel, channelOutbound.kind, channelOutbound.subject],
        // A newer instruction supersedes the old one and gets a fresh start:
        // the previous failure was about content that no longer applies.
        set: { payload, availableAt: now, attempts: 0, lastError: null },
      })
  }

  async pending(channel: string, limit?: number): Promise<OutboundItem[]> {
    const rows = await this.db
      .select()
      .from(channelOutbound)
      .where(and(eq(channelOutbound.channel, channel), lte(channelOutbound.availableAt, this.clock())))
      .orderBy(asc(channelOutbound.availableAt), asc(channelOutbound.createdAt))
      .limit(limit ?? this.options.batchSize ?? 50)

    return rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      kind: row.kind as OutboundKind,
      subject: row.subject,
      payload: row.payload,
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt,
    }))
  }

  /**
   * Sends what is due, backing off on failure.
   *
   * Failures stay in the queue rather than being dropped: an order status the
   * channel never receives is a customer who is never told their parcel
   * shipped.
   */
  async dispatch(channel: string, send: (item: OutboundItem) => Promise<void>): Promise<DispatchResult> {
    const items = await this.pending(channel)
    let sent = 0
    let failed = 0

    for (const item of items) {
      try {
        await send(item)
        await this.db.delete(channelOutbound).where(eq(channelOutbound.id, item.id))
        sent += 1
      } catch (error) {
        failed += 1
        const attempts = item.attempts + 1
        const base = this.options.baseBackoffMs ?? 1000
        const max = this.options.maxBackoffMs ?? 5 * 60 * 1000
        const delay = Math.min(base * 2 ** (attempts - 1), max)

        await this.db
          .update(channelOutbound)
          .set({
            attempts,
            lastError: (error as Error).message,
            availableAt: new Date(this.clock().getTime() + delay),
          })
          .where(eq(channelOutbound.id, item.id))
      }
    }

    const [remaining] = await this.db
      .select({ value: count() })
      .from(channelOutbound)
      .where(eq(channelOutbound.channel, channel))

    return { sent, failed, remaining: remaining?.value ?? 0 }
  }

  /** Queue depth and the age of the oldest item, for a monitoring screen. */
  async status(channel: string): Promise<OutboundStatus> {
    const [row] = await this.db
      .select({
        pending: count(),
        oldest: sql<Date | null>`min(${channelOutbound.createdAt})`,
        failing: sql<string>`count(*) filter (where ${channelOutbound.attempts} > 0)::text`,
      })
      .from(channelOutbound)
      .where(eq(channelOutbound.channel, channel))

    const oldest = row?.oldest ?? null
    return {
      channel,
      pending: row?.pending ?? 0,
      oldestAgeMs: oldest === null ? null : this.clock().getTime() - new Date(oldest).getTime(),
      failing: Number(row?.failing ?? 0),
    }
  }
}
