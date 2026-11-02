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
  readonly suggestedCounterpartyId: string | null
  readonly paymentMethod: string | null
  readonly shippingMinor: number
  readonly payload: Record<string, unknown>
}

/** What a person decided about a parked order's customer. */
export interface ResolveDecision {
  /** Link the order's identity to this existing customer. */
  readonly counterpartyId?: string
  /** The identity is somebody new. */
  readonly newCustomer?: boolean
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

      const { state, reason, counterpartyId, suggestedCounterpartyId } = await this.assess(channel, order)

      await this.db.transaction(async (tx) => {
        await tx.insert(channelInboxOrders).values({
          channel,
          externalId: order.externalId,
          placedAt: order.placedAt,
          state,
          parkedReason: reason ?? null,
          currency: order.currency,
          totalMinor: order.totalMinor,
          shippingMinor: order.shippingMinor ?? 0,
          paymentMethod: order.paymentMethod ?? null,
          suggestedCounterpartyId: suggestedCounterpartyId ?? null,
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
  ): Promise<{
    state: InboxState
    reason?: string
    counterpartyId: string | null
    suggestedCounterpartyId?: string
  }> {
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

    const mismatch = totalsMismatch(order)
    if (mismatch !== null) return { state: 'parked', reason: mismatch, counterpartyId: null }

    const resolution = await this.customers.resolve(channel, order.customer)
    if (resolution.kind === 'suggested') {
      return {
        state: 'parked',
        reason: 'customer match needs confirmation',
        counterpartyId: null,
        suggestedCounterpartyId: resolution.counterparty.id,
      }
    }
    const counterparty = resolution.counterparty

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

  /**
   * Accepts a parked or oversold order once a person has sorted it out.
   *
   * Refuses while a line still names a variant nobody mapped, or while the
   * totals still disagree: accepting those would produce a document that is
   * wrong. For an order waiting on a customer match the person says who the
   * customer is - the suggested one, another, or somebody new - and that
   * identity is linked from then on.
   */
  async resolve(channel: string, externalId: string, decision: ResolveDecision = {}): Promise<InboxOrder> {
    const found = await this.find(channel, externalId)
    if (found === null) throw new Error(`No order ${channel}:${externalId}`)
    if (found.state === 'accepted') return found

    const order = payloadToOrder(found.payload)
    const localIds = await this.mappings.localIdsFor(
      channel,
      'variant',
      order.lines.map((line) => line.externalVariantId),
    )
    const unmapped = order.lines.filter((line) => !localIds.has(line.externalVariantId))
    if (unmapped.length > 0) {
      throw new Error(
        `Order ${externalId} still names unknown variants: ${unmapped.map((l) => l.externalVariantId).join(', ')}`,
      )
    }
    const mismatch = totalsMismatch(order)
    if (mismatch !== null) throw new Error(`Order ${externalId} cannot be accepted: ${mismatch}`)

    let counterpartyId = found.counterpartyId
    if (counterpartyId === null) {
      const linked = await this.customers.findLinked(channel, order.customer.externalId)
      if (linked !== null) counterpartyId = linked.id
      else if (decision.counterpartyId !== undefined) {
        counterpartyId = (
          await this.customers.link(channel, order.customer.externalId, decision.counterpartyId)
        ).id
      } else if (decision.newCustomer === true) {
        counterpartyId = (await this.customers.createAndLink(channel, order.customer)).id
      } else {
        const resolution = await this.customers.resolve(channel, order.customer)
        if (resolution.kind === 'suggested') {
          throw new Error(
            `Order ${externalId} waits for a person to say who the customer is (suggested: ${resolution.counterparty.id})`,
          )
        }
        counterpartyId = resolution.counterparty.id
      }
    }

    await this.db
      .update(channelInboxOrders)
      .set({ state: 'accepted', resolvedAt: new Date(), parkedReason: null, counterpartyId })
      .where(and(eq(channelInboxOrders.channel, channel), eq(channelInboxOrders.externalId, externalId)))
    const resolved = await this.find(channel, externalId)
    if (resolved === null) throw new Error(`No order ${channel}:${externalId}`)
    return resolved
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
  suggestedCounterpartyId: string | null
  paymentMethod: string | null
  shippingMinor: number
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
    suggestedCounterpartyId: row.suggestedCounterpartyId,
    paymentMethod: row.paymentMethod,
    shippingMinor: row.shippingMinor,
    payload: row.payload,
  }
}

/**
 * Says what is wrong when lines plus delivery do not make the total, or null.
 *
 * Never adjusted: a kopeck that does not add up is either a channel bug or a
 * discount we do not model yet, and a person should see which.
 */
export function totalsMismatch(
  order: Pick<ChannelOrder, 'lines' | 'shippingMinor' | 'totalMinor'>,
): string | null {
  const lines = order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0)
  const shipping = order.shippingMinor ?? 0
  const difference = order.totalMinor - lines - shipping
  if (difference === 0) return null
  return `totals do not reconcile: lines ${lines} + delivery ${shipping} = ${lines + shipping}, total ${order.totalMinor}, difference ${difference}`
}

/** The order as it was received, read back from the inbox payload. */
export function payloadToOrder(payload: Record<string, unknown>): ChannelOrder {
  const raw = payload as unknown as ChannelOrder & { placedAt: string | Date }
  return { ...raw, placedAt: new Date(raw.placedAt) }
}
