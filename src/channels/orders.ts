import { and, asc, eq } from 'drizzle-orm'
import { recordChange } from '../change-feed/record.js'
import type { Database } from '../db/client.js'
import type { ChannelOrder, ChannelOrderStatusUpdate, SalesChannelAdapter } from './contract.js'
import { ChannelCustomers } from './customers.js'
import { ChannelMappings } from './mappings.js'
import { ChannelOutbound } from './outbound.js'
import { channelInboxOrders, channelState } from './schema.js'
import type { StockSource } from './stock.js'

export type InboxState = 'accepted' | 'parked' | 'oversold'

export interface InboxOrder {
  readonly id: string
  readonly channel: string
  readonly externalId: string
  readonly state: InboxState
  readonly parkedReason: string | null
  readonly placedAt: Date
  readonly receivedAt: Date
  readonly totalMinor: number
  readonly currency: string
  readonly counterpartyId: string | null
  readonly payload: Record<string, unknown>
}

export interface IntakeResult {
  readonly received: number
  readonly accepted: number
  readonly parked: number
  readonly oversold: number
  readonly duplicates: number
}

export interface OrderIntakeOptions {
  /** Checked at intake so an order for goods we do not have is flagged, not lost. */
  readonly stock?: StockSource
}

/**
 * Orders arriving from a channel.
 *
 * Every order is recorded before it is understood. A line naming a variant we
 * cannot map, or goods we do not have, parks the order for a person instead of
 * failing the fetch: somebody placed that order and often paid for it, and the
 * one outcome that must never happen is losing it quietly.
 */
export class ChannelOrders {
  private readonly mappings: ChannelMappings
  private readonly customers: ChannelCustomers
  private readonly outbound: ChannelOutbound

  constructor(
    private readonly db: Database,
    private readonly options: OrderIntakeOptions = {},
  ) {
    this.mappings = new ChannelMappings(db)
    this.customers = new ChannelCustomers(db)
    this.outbound = new ChannelOutbound(db)
  }

  /** Fetches and records everything placed since the last successful fetch. */
  async fetch(channel: string, adapter: SalesChannelAdapter): Promise<IntakeResult> {
    const since = (await this.lastFetchAt(channel)) ?? new Date(0)
    const orders = await adapter.fetchOrders(since)
    const result = await this.receive(channel, orders)

    // Advanced only after the batch is safely recorded: moving it first would
    // skip orders whose recording failed.
    const latest = orders.reduce<Date>(
      (newest, order) => (order.placedAt > newest ? order.placedAt : newest),
      since,
    )
    await this.setLastFetchAt(channel, latest)
    return result
  }

  async receive(channel: string, orders: readonly ChannelOrder[]): Promise<IntakeResult> {
    let accepted = 0
    let parked = 0
    let oversold = 0
    let duplicates = 0

    for (const order of orders) {
      const existing = await this.find(channel, order.externalId)
      if (existing !== null) {
        duplicates += 1
        continue
      }

      const { state, reason, counterpartyId } = await this.assess(channel, order)

      await this.db.transaction(async (tx) => {
        await tx.insert(channelInboxOrders).values({
          channel,
          externalId: order.externalId,
          placedAt: order.placedAt,
          state,
          parkedReason: reason ?? null,
          currency: order.currency,
          totalMinor: order.totalMinor,
          counterpartyId,
          payload: { ...order, placedAt: order.placedAt.toISOString() },
        })

        await recordChange(tx, {
          entityType: 'channel_order',
          entityId: `${channel}:${order.externalId}`,
          kind: 'created',
          actor: { type: 'integration', id: channel },
        })
      })

      if (state === 'accepted') accepted += 1
      else if (state === 'oversold') oversold += 1
      else parked += 1
    }

    return { received: orders.length, accepted, parked, oversold, duplicates }
  }

  /** Decides whether an order can be taken as it stands. */
  private async assess(
    channel: string,
    order: ChannelOrder,
  ): Promise<{ state: InboxState; reason?: string; counterpartyId: string | null }> {
    const externalVariantIds = order.lines.map((line) => line.externalVariantId)
    const localIds = await this.mappings.localIdsFor(channel, 'variant', externalVariantIds)

    const unmapped = externalVariantIds.filter((id) => !localIds.has(id))
    if (unmapped.length > 0) {
      return {
        state: 'parked',
        reason: `unknown variant: ${unmapped.join(', ')}`,
        counterpartyId: null,
      }
    }

    const counterparty = await this.customers.resolve(channel, order.customer)

    if (this.options.stock !== undefined) {
      const wanted = new Map<string, number>()
      for (const line of order.lines) {
        const localId = localIds.get(line.externalVariantId)
        if (localId === undefined) continue
        wanted.set(localId, (wanted.get(localId) ?? 0) + line.quantity)
      }

      const available = await this.options.stock.availableFor([...wanted.keys()])
      const short = [...wanted.entries()].filter(
        ([localId, quantity]) => (available.get(localId) ?? 0) < quantity,
      )
      if (short.length > 0) {
        // Recorded, not refused: the customer has already paid, and refusing
        // here would leave the order nowhere at all.
        return {
          state: 'oversold',
          reason: `not enough stock for ${short.map(([id]) => id).join(', ')}`,
          counterpartyId: counterparty.id,
        }
      }
    }

    return { state: 'accepted', counterpartyId: counterparty.id }
  }

  async find(channel: string, externalId: string): Promise<InboxOrder | null> {
    const [row] = await this.db
      .select()
      .from(channelInboxOrders)
      .where(and(eq(channelInboxOrders.channel, channel), eq(channelInboxOrders.externalId, externalId)))
      .limit(1)
    return row === undefined ? null : toInboxOrder(row)
  }

  async list(channel: string, state?: InboxState): Promise<InboxOrder[]> {
    const rows = await this.db
      .select()
      .from(channelInboxOrders)
      .where(
        state === undefined
          ? eq(channelInboxOrders.channel, channel)
          : and(eq(channelInboxOrders.channel, channel), eq(channelInboxOrders.state, state)),
      )
      .orderBy(asc(channelInboxOrders.receivedAt))
    return rows.map(toInboxOrder)
  }

  /** Marks a parked order as dealt with, once a person has sorted it out. */
  async resolve(channel: string, externalId: string): Promise<void> {
    await this.db
      .update(channelInboxOrders)
      .set({ state: 'accepted', resolvedAt: new Date(), parkedReason: null })
      .where(and(eq(channelInboxOrders.channel, channel), eq(channelInboxOrders.externalId, externalId)))
  }

  /**
   * Tells the channel where an order stands.
   *
   * Queued rather than sent: a customer must be told their parcel shipped even
   * if the channel was unreachable at the moment we marked it.
   */
  async publishStatus(channel: string, update: ChannelOrderStatusUpdate): Promise<void> {
    await this.outbound.enqueue(channel, 'order_status', update.externalOrderId, { ...update })
  }

  private async lastFetchAt(channel: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: channelState.lastOrderFetchAt })
      .from(channelState)
      .where(eq(channelState.channel, channel))
      .limit(1)
    return row?.at ?? null
  }

  private async setLastFetchAt(channel: string, at: Date): Promise<void> {
    await this.db
      .insert(channelState)
      .values({ channel, lastOrderFetchAt: at })
      .onConflictDoUpdate({
        target: channelState.channel,
        set: { lastOrderFetchAt: at, updatedAt: new Date() },
      })
  }
}

function toInboxOrder(row: {
  id: string
  channel: string
  externalId: string
  state: string
  parkedReason: string | null
  placedAt: Date
  receivedAt: Date
  totalMinor: number
  currency: string
  counterpartyId: string | null
  payload: Record<string, unknown>
}): InboxOrder {
  return {
    id: row.id,
    channel: row.channel,
    externalId: row.externalId,
    state: row.state as InboxState,
    parkedReason: row.parkedReason,
    placedAt: row.placedAt,
    receivedAt: row.receivedAt,
    totalMinor: row.totalMinor,
    currency: row.currency,
    counterpartyId: row.counterpartyId,
    payload: row.payload,
  }
}
