import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { recordChange } from '../change-feed/record.js'
import type { Executor } from '../change-feed/types.js'
import type { ChannelOrderStatus } from '../channels/contract.js'
import { ChannelMappings } from '../channels/mappings.js'
import { payloadToOrder } from '../channels/orders.js'
import { ChannelOutbound } from '../channels/outbound.js'
import { channelInboxOrders } from '../channels/schema.js'
import type { Database } from '../db/client.js'
import {
  LegalEntities,
  type LegalEntityReference,
  nextDocumentNumber,
} from '../legal-entities/legal-entities.js'
import { type Actor, requireActor } from '../tenancy/context.js'
import {
  type PaymentRow,
  payments,
  type SalesOrderLineRow,
  type SalesOrderRow,
  type SalesOrderStatus,
  salesOrderEvents,
  salesOrderLines,
  salesOrders,
  salesOrderWithdrawnNumbers,
} from './schema.js'

export class SalesOrderError extends Error {
  override readonly name = 'SalesOrderError'
}

export class SalesOrderNotFoundError extends SalesOrderError {
  constructor(readonly id: string) {
    super(`No sales order with id ${id}`)
  }
}

/** Only a person may decide this. */
export class PersonRequiredError extends SalesOrderError {
  constructor(
    readonly what: string,
    readonly actor: Actor,
  ) {
    super(`${what} must be done by a person, not ${actor.type} ${actor.id}`)
  }
}

export class TransitionRefusedError extends SalesOrderError {
  constructor(
    readonly from: SalesOrderStatus,
    readonly to: SalesOrderStatus,
    reason?: string,
  ) {
    super(`An order cannot go from ${from} to ${to}${reason === undefined ? '' : `: ${reason}`}`)
  }
}

/** The entity of an order that money already reached cannot change. */
export class EntityFixedError extends SalesOrderError {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} has a recorded payment; its legal entity is fixed`)
  }
}

/** Money landed in one entity's account and the order belongs to another. */
export class PaymentEntityMismatchError extends SalesOrderError {
  constructor(
    readonly orderId: string,
    readonly orderEntityId: string,
    readonly paymentEntityId: string,
  ) {
    super(
      `Payment received by entity ${paymentEntityId} cannot be attached to order ${orderId} of entity ${orderEntityId}`,
    )
  }
}

/** Which transitions exist. Everything else is refused. */
export const TRANSITIONS: Readonly<Record<SalesOrderStatus, readonly SalesOrderStatus[]>> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['paid', 'cancelled'],
  paid: ['shipped', 'refunded'],
  shipped: ['refunded'],
  cancelled: [],
  refunded: [],
}

/** Statuses the originating channel is told about. */
const PUBLISHED: readonly SalesOrderStatus[] = ['confirmed', 'paid', 'shipped', 'cancelled', 'refunded']

export interface SalesOrderLine {
  readonly position: number
  readonly variantId: string
  readonly quantity: number
  readonly unitPriceMinor: number
  readonly lineTotalMinor: number
}

export interface Payment {
  readonly id: string
  readonly legalEntityId: string
  readonly amountMinor: number
  readonly currency: string
  readonly paidAt: Date
  readonly source: string
  readonly reference: string
  readonly actorType: string
  readonly actorId: string
}

export interface SalesOrder {
  readonly id: string
  readonly channel: string
  readonly channelOrderId: string
  readonly contractorId: string
  readonly paymentMethod: string | null
  readonly suggestedEntityId: string | null
  readonly legalEntityId: string | null
  readonly entityConfirmedBy: { readonly type: string; readonly id: string; readonly at: Date } | null
  readonly number: number | null
  readonly status: SalesOrderStatus
  readonly currency: string
  readonly itemsMinor: number
  readonly shippingMinor: number
  readonly totalMinor: number
  /** Computed here, never by a screen: total minus what has been paid. */
  readonly paidMinor: number
  readonly outstandingMinor: number
  readonly delivery: Record<string, unknown> | null
  readonly deliveryNote: string | null
  readonly trackingReference: string | null
  readonly placedAt: Date
  readonly lines: readonly SalesOrderLine[]
  readonly payments: readonly Payment[]
}

export interface PaymentInput {
  readonly orderId: string
  readonly amountMinor: number
  readonly currency: string
  readonly paidAt: Date
  /** `manual` for a person, otherwise the provider or statement it came from. */
  readonly source: string
  /** The source's own identifier; for a manual payment, the form's idempotency key. */
  readonly reference: string
  /** The entity whose account received the money. Defaults to the order's. */
  readonly legalEntityId?: string
}

export interface PaymentResult {
  readonly payment: Payment
  readonly duplicate: boolean
  readonly order: SalesOrder
}

export interface SalesOrderQueue {
  readonly awaitingEntity: readonly SalesOrder[]
  readonly awaitingPayment: readonly SalesOrder[]
  readonly awaitingShipment: readonly SalesOrder[]
  readonly parked: readonly {
    readonly channel: string
    readonly externalId: string
    readonly state: string
    readonly reason: string | null
    readonly suggestedCounterpartyId: string | null
    readonly totalMinor: number
    readonly currency: string
    readonly receivedAt: Date
  }[]
}

/**
 * Customer orders as documents.
 *
 * The machine suggests which legal entity an order belongs to; a person
 * decides, and only then does the order get a number. Money arriving fixes the
 * entity for good, because by then it is a fact about a bank account.
 */
export class SalesOrders {
  private readonly entities: LegalEntities
  private readonly outbound: ChannelOutbound
  private readonly mappings: ChannelMappings

  constructor(private readonly db: Database) {
    this.entities = new LegalEntities(db)
    this.outbound = new ChannelOutbound(db)
    this.mappings = new ChannelMappings(db)
  }

  /**
   * Creates a sales order for every accepted inbox order that has none yet.
   *
   * Safe to run any number of times: the inbox order id is unique on the
   * sales order, so a second run finds nothing to do.
   */
  async materialise(channel?: string): Promise<number> {
    const pending = await this.db
      .select({ inbox: channelInboxOrders })
      .from(channelInboxOrders)
      .leftJoin(salesOrders, eq(salesOrders.inboxOrderId, channelInboxOrders.id))
      .where(
        and(
          eq(channelInboxOrders.state, 'accepted'),
          isNull(salesOrders.id),
          channel === undefined ? undefined : eq(channelInboxOrders.channel, channel),
        ),
      )
      .orderBy(asc(channelInboxOrders.receivedAt))

    let created = 0
    for (const { inbox } of pending) {
      if (inbox.counterpartyId === null) continue
      const order = payloadToOrder(inbox.payload)
      const localIds = await this.mappings.localIdsFor(
        inbox.channel,
        'variant',
        order.lines.map((line) => line.externalVariantId),
      )
      const suggested = await this.entities.suggestFor(inbox.paymentMethod)
      const itemsMinor = order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0)
      const actor: Actor = { type: 'integration', id: inbox.channel }

      const inserted = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(salesOrders)
          .values({
            inboxOrderId: inbox.id,
            channel: inbox.channel,
            channelOrderId: inbox.externalId,
            contractorId: inbox.counterpartyId as string,
            paymentMethod: inbox.paymentMethod,
            suggestedEntityId: suggested,
            status: 'new',
            currency: inbox.currency,
            itemsMinor,
            shippingMinor: inbox.shippingMinor,
            totalMinor: inbox.totalMinor,
            delivery: order.delivery === undefined ? null : { ...order.delivery },
            deliveryNote: order.deliveryNote ?? null,
            placedAt: inbox.placedAt,
          })
          .onConflictDoNothing({ target: salesOrders.inboxOrderId })
          .returning()
        if (row === undefined) return false

        await tx.insert(salesOrderLines).values(
          order.lines.map((line, index) => {
            const variantId = localIds.get(line.externalVariantId)
            if (variantId === undefined) {
              throw new SalesOrderError(
                `Order ${inbox.externalId} names unmapped variant ${line.externalVariantId}`,
              )
            }
            return {
              orderId: row.id,
              position: index + 1,
              variantId,
              quantity: line.quantity,
              unitPriceMinor: line.unitPriceMinor,
              lineTotalMinor: line.quantity * line.unitPriceMinor,
            }
          }),
        )
        await this.event(tx, row.id, actor, { kind: 'status', toValue: 'new' })
        await recordChange(tx, { entityType: 'sales_order', entityId: row.id, kind: 'created', actor })
        return true
      })
      if (inserted) created += 1
    }
    return created
  }

  async find(id: string): Promise<SalesOrder | null> {
    const [row] = await this.db.select().from(salesOrders).where(eq(salesOrders.id, id)).limit(1)
    if (row === undefined) return null
    return (await this.hydrate([row]))[0] ?? null
  }

  async require(id: string): Promise<SalesOrder> {
    const found = await this.find(id)
    if (found === null) throw new SalesOrderNotFoundError(id)
    return found
  }

  async findByChannelOrder(channel: string, channelOrderId: string): Promise<SalesOrder | null> {
    const [row] = await this.db
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.channel, channel), eq(salesOrders.channelOrderId, channelOrderId)))
      .limit(1)
    if (row === undefined) return null
    return (await this.hydrate([row]))[0] ?? null
  }

  /**
   * A person confirms which legal entity the order belongs to.
   *
   * Issues the order's number from that entity's sequence. Confirming the same
   * entity again returns the order as it is, with the number it already has.
   */
  async confirmEntity(orderId: string, legalEntityId: string): Promise<SalesOrder> {
    const actor = requirePerson('Confirming the legal entity of an order')
    await this.entities.requireActive(legalEntityId)

    const published = await this.db.transaction(async (tx) => {
      const order = await this.lock(tx, orderId)
      if (order.legalEntityId === legalEntityId && order.number !== null) return []
      if (order.legalEntityId !== null) {
        throw new SalesOrderError(`Order ${orderId} is already confirmed; change its entity instead`)
      }
      assertTransition(order.status, 'confirmed')

      const paid = await this.paymentsOf(tx, orderId)
      const elsewhere = paid.find((payment) => payment.legalEntityId !== legalEntityId)
      if (elsewhere !== undefined) {
        throw new PaymentEntityMismatchError(orderId, legalEntityId, elsewhere.legalEntityId)
      }

      const number = await nextDocumentNumber(tx, legalEntityId, 'sales_order')
      const now = new Date()
      await tx
        .update(salesOrders)
        .set({
          legalEntityId,
          number,
          status: 'confirmed',
          entityConfirmedByType: actor.type,
          entityConfirmedById: actor.id,
          entityConfirmedAt: now,
          updatedAt: now,
        })
        .where(eq(salesOrders.id, orderId))
      await this.event(tx, orderId, actor, {
        kind: 'entity_confirmed',
        toValue: legalEntityId,
        note: `№${number}`,
      })
      await this.event(tx, orderId, actor, { kind: 'status', fromValue: order.status, toValue: 'confirmed' })
      await recordChange(tx, {
        entityType: 'sales_order',
        entityId: orderId,
        kind: 'updated',
        changedFields: ['legalEntityId', 'number', 'status'],
      })

      const statuses: SalesOrderStatus[] = ['confirmed']
      if (sum(paid) >= order.totalMinor) {
        await this.setStatus(tx, orderId, actor, 'confirmed', 'paid')
        statuses.push('paid')
      }
      return statuses
    })

    const order = await this.require(orderId)
    for (const status of published) await this.publish(order, status)
    return order
  }

  /**
   * A person moves a confirmed order to another entity before money arrives.
   *
   * The order takes the next number of the new entity. Its old number stays on
   * record as withdrawn, and the old sequence never issues it again.
   */
  async changeEntity(orderId: string, legalEntityId: string): Promise<SalesOrder> {
    const actor = requirePerson('Changing the legal entity of an order')
    await this.entities.requireActive(legalEntityId)

    await this.db.transaction(async (tx) => {
      const order = await this.lock(tx, orderId)
      if (order.legalEntityId === null || order.number === null) {
        throw new SalesOrderError(`Order ${orderId} has no confirmed entity to change`)
      }
      if (order.legalEntityId === legalEntityId) return
      if ((await this.paymentsOf(tx, orderId)).length > 0) throw new EntityFixedError(orderId)
      if (order.status !== 'confirmed') {
        throw new SalesOrderError(`Order ${orderId} is ${order.status}; its entity can no longer change`)
      }

      await tx.insert(salesOrderWithdrawnNumbers).values({
        orderId,
        legalEntityId: order.legalEntityId,
        number: order.number,
        actorType: actor.type,
        actorId: actor.id,
      })
      const number = await nextDocumentNumber(tx, legalEntityId, 'sales_order')
      await tx
        .update(salesOrders)
        .set({ legalEntityId, number, updatedAt: new Date() })
        .where(eq(salesOrders.id, orderId))
      await this.event(tx, orderId, actor, {
        kind: 'entity_changed',
        fromValue: order.legalEntityId,
        toValue: legalEntityId,
        note: `№${order.number} withdrawn, №${number} issued`,
      })
      await recordChange(tx, {
        entityType: 'sales_order',
        entityId: orderId,
        kind: 'updated',
        changedFields: ['legalEntityId', 'number'],
      })
    })
    return await this.require(orderId)
  }

  /** Numbers an order held and gave up when its entity changed. */
  async withdrawnNumbers(orderId: string): Promise<readonly { legalEntityId: string; number: number }[]> {
    const rows = await this.db
      .select()
      .from(salesOrderWithdrawnNumbers)
      .where(eq(salesOrderWithdrawnNumbers.orderId, orderId))
      .orderBy(asc(salesOrderWithdrawnNumbers.withdrawnAt))
    return rows.map((row) => ({ legalEntityId: row.legalEntityId, number: row.number }))
  }

  /**
   * Records money that arrived for an order.
   *
   * The same source and reference twice is one payment. A payment received by
   * an entity other than the order's is refused and reported, not attached.
   * The order becomes paid once its payments cover the total - and only once
   * it is confirmed, because an order nobody has looked at is not yet ours.
   */
  async recordPayment(input: PaymentInput): Promise<PaymentResult> {
    const actor = authorisePaymentSource(input.source)
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new SalesOrderError('A payment must be a positive whole number of minor units')
    }

    const [existing] = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.source, input.source), eq(payments.reference, input.reference)))
      .limit(1)
    if (existing !== undefined) {
      return { payment: toPayment(existing), duplicate: true, order: await this.require(existing.orderId) }
    }

    const published = await this.db.transaction(async (tx) => {
      const order = await this.lock(tx, input.orderId)
      if (order.currency !== input.currency) {
        throw new SalesOrderError(
          `Order ${order.id} is in ${order.currency}, the payment in ${input.currency}`,
        )
      }
      if (order.status === 'cancelled' || order.status === 'refunded') {
        throw new SalesOrderError(
          `Order ${order.id} is ${order.status}; a payment for it needs a person to sort out`,
        )
      }
      const receivedBy = input.legalEntityId ?? order.legalEntityId
      if (receivedBy === null) {
        throw new SalesOrderError(
          `Say which entity received the money: order ${order.id} is not confirmed yet`,
        )
      }
      if (order.legalEntityId !== null && receivedBy !== order.legalEntityId) {
        throw new PaymentEntityMismatchError(order.id, order.legalEntityId, receivedBy)
      }
      const before = await this.paymentsOf(tx, order.id)
      const other = before.find((payment) => payment.legalEntityId !== receivedBy)
      if (other !== undefined) throw new PaymentEntityMismatchError(order.id, other.legalEntityId, receivedBy)

      const [row] = await tx
        .insert(payments)
        .values({
          orderId: order.id,
          legalEntityId: receivedBy,
          amountMinor: input.amountMinor,
          currency: input.currency,
          paidAt: input.paidAt,
          source: input.source,
          reference: input.reference,
          actorType: actor.type,
          actorId: actor.id,
        })
        .onConflictDoNothing({ target: [payments.source, payments.reference] })
        .returning()
      if (row === undefined) return null
      await recordChange(tx, { entityType: 'payment', entityId: row.id, kind: 'created' })

      if (order.status === 'confirmed' && sum([...before, row]) >= order.totalMinor) {
        await this.setStatus(tx, order.id, actor, 'confirmed', 'paid')
        return { payment: row, statuses: ['paid'] as SalesOrderStatus[] }
      }
      return { payment: row, statuses: [] as SalesOrderStatus[] }
    })

    if (published === null) {
      // Lost a race with an identical payment: the other one is the fact.
      return await this.recordPayment(input)
    }
    const order = await this.require(input.orderId)
    for (const status of published.statuses) await this.publish(order, status)
    return { payment: toPayment(published.payment), duplicate: false, order }
  }

  /** A person marks a paid order shipped, with the carrier's tracking number. */
  async ship(orderId: string, trackingReference: string): Promise<SalesOrder> {
    const actor = requirePerson('Shipping an order')
    const tracking = trackingReference.trim()
    if (tracking === '') throw new SalesOrderError('A shipment needs a tracking reference')
    await this.db.transaction(async (tx) => {
      const order = await this.lock(tx, orderId)
      assertTransition(order.status, 'shipped')
      await tx.update(salesOrders).set({ trackingReference: tracking }).where(eq(salesOrders.id, orderId))
      await this.setStatus(tx, orderId, actor, order.status, 'shipped', tracking)
    })
    const order = await this.require(orderId)
    await this.publish(order, 'shipped')
    return order
  }

  async cancel(orderId: string, note?: string): Promise<SalesOrder> {
    const actor = requirePerson('Cancelling an order')
    await this.db.transaction(async (tx) => {
      const order = await this.lock(tx, orderId)
      if (order.status === 'paid' || order.status === 'shipped') {
        throw new TransitionRefusedError(order.status, 'cancelled', 'money has arrived; refund it instead')
      }
      assertTransition(order.status, 'cancelled')
      await this.setStatus(tx, orderId, actor, order.status, 'cancelled', note)
    })
    const order = await this.require(orderId)
    await this.publish(order, 'cancelled')
    return order
  }

  async refund(orderId: string, note?: string): Promise<SalesOrder> {
    const actor = requirePerson('Refunding an order')
    await this.db.transaction(async (tx) => {
      const order = await this.lock(tx, orderId)
      assertTransition(order.status, 'refunded')
      await this.setStatus(tx, orderId, actor, order.status, 'refunded', note)
    })
    const order = await this.require(orderId)
    await this.publish(order, 'refunded')
    return order
  }

  async events(orderId: string): Promise<readonly (typeof salesOrderEvents.$inferSelect)[]> {
    return await this.db
      .select()
      .from(salesOrderEvents)
      .where(eq(salesOrderEvents.orderId, orderId))
      .orderBy(asc(salesOrderEvents.sequence))
  }

  /** What is waiting for staff, oldest first. Every figure is computed here. */
  async queue(): Promise<SalesOrderQueue> {
    const open = await this.db
      .select()
      .from(salesOrders)
      .where(inArray(salesOrders.status, ['new', 'confirmed', 'paid']))
      .orderBy(asc(salesOrders.placedAt))
    const hydrated = await this.hydrate(open)

    const parked = await this.db
      .select()
      .from(channelInboxOrders)
      .where(inArray(channelInboxOrders.state, ['parked', 'oversold']))
      .orderBy(asc(channelInboxOrders.receivedAt))

    return {
      awaitingEntity: hydrated.filter((order) => order.status === 'new'),
      awaitingPayment: hydrated.filter((order) => order.status === 'confirmed'),
      awaitingShipment: hydrated.filter((order) => order.status === 'paid'),
      parked: parked.map((row) => ({
        channel: row.channel,
        externalId: row.externalId,
        state: row.state,
        reason: row.parkedReason,
        suggestedCounterpartyId: row.suggestedCounterpartyId,
        totalMinor: row.totalMinor,
        currency: row.currency,
        receivedAt: row.receivedAt,
      })),
    }
  }

  private async lock(tx: Executor, orderId: string): Promise<SalesOrderRow> {
    const [row] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId)).for('update')
    if (row === undefined) throw new SalesOrderNotFoundError(orderId)
    return row
  }

  private async paymentsOf(tx: Executor, orderId: string): Promise<PaymentRow[]> {
    return await tx.select().from(payments).where(eq(payments.orderId, orderId))
  }

  private async setStatus(
    tx: Executor,
    orderId: string,
    actor: Actor,
    from: SalesOrderStatus,
    to: SalesOrderStatus,
    note?: string,
  ): Promise<void> {
    assertTransition(from, to)
    await tx.update(salesOrders).set({ status: to, updatedAt: new Date() }).where(eq(salesOrders.id, orderId))
    await this.event(tx, orderId, actor, { kind: 'status', fromValue: from, toValue: to, note })
    await recordChange(tx, {
      entityType: 'sales_order',
      entityId: orderId,
      kind: 'updated',
      changedFields: ['status'],
    })
  }

  private async event(
    tx: Executor,
    orderId: string,
    actor: Actor,
    event: { kind: string; fromValue?: string; toValue?: string; note?: string | undefined },
  ): Promise<void> {
    await tx.insert(salesOrderEvents).values({
      orderId,
      kind: event.kind,
      fromValue: event.fromValue ?? null,
      toValue: event.toValue ?? null,
      note: event.note ?? null,
      actorType: actor.type,
      actorId: actor.id,
    })
  }

  /**
   * Queues the status for the channel the order came from.
   *
   * One queue item per order and status, so a quick confirmed-then-paid does
   * not collapse into a single message and the channel hears both. The order's
   * status in the core never waits for the channel.
   */
  private async publish(order: SalesOrder, status: SalesOrderStatus): Promise<void> {
    if (!PUBLISHED.includes(status)) return
    await this.outbound.enqueue(order.channel, 'order_status', `${order.channelOrderId}:${status}`, {
      externalOrderId: order.channelOrderId,
      status: status as ChannelOrderStatus,
      ...(status === 'shipped' && order.trackingReference !== null
        ? { trackingReference: order.trackingReference }
        : {}),
    })
  }

  private async hydrate(rows: readonly SalesOrderRow[]): Promise<SalesOrder[]> {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const [lines, paid] = await Promise.all([
      this.db
        .select()
        .from(salesOrderLines)
        .where(inArray(salesOrderLines.orderId, ids))
        .orderBy(asc(salesOrderLines.position)),
      this.db.select().from(payments).where(inArray(payments.orderId, ids)).orderBy(asc(payments.paidAt)),
    ])
    return rows.map((row) =>
      toSalesOrder(
        row,
        lines.filter((line) => line.orderId === row.id),
        paid.filter((payment) => payment.orderId === row.id),
      ),
    )
  }
}

/** Lets the legal entity registry refuse to delete an entity orders use. */
export const salesOrdersReferenceEntities: LegalEntityReference = {
  async heldBy(db, legalEntityId) {
    const [order] = await db
      .select({ id: salesOrders.id, number: salesOrders.number })
      .from(salesOrders)
      .where(
        sql`${salesOrders.legalEntityId} = ${legalEntityId} or ${salesOrders.suggestedEntityId} = ${legalEntityId}`,
      )
      .limit(1)
    if (order !== undefined) return `sales order ${order.number ?? order.id}`
    const [payment] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.legalEntityId, legalEntityId))
      .limit(1)
    return payment === undefined ? null : `payment ${payment.id}`
  },
}

export function assertTransition(from: SalesOrderStatus, to: SalesOrderStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new TransitionRefusedError(from, to)
}

/**
 * Who may say money arrived, and through which source.
 *
 * The source is part of the fact, so it is bound to whoever states it rather
 * than taken from the request: a person records only `manual` payments, an
 * integration only payments under its own name, and a bot none at all - a bot
 * claiming "the provider says it is paid" would otherwise mark any order paid.
 */
function authorisePaymentSource(source: string): Actor {
  const actor = requireActor('A payment')
  if (actor.type === 'human') {
    if (source !== 'manual') {
      throw new SalesOrderError(`A person records payments as "manual", not as "${source}"`)
    }
    return actor
  }
  if (actor.type === 'integration') {
    if (source === 'manual' || source !== actor.id) {
      throw new SalesOrderError(
        `Integration ${actor.id} may only record payments from its own source, not "${source}"`,
      )
    }
    return actor
  }
  throw new PersonRequiredError('Recording a payment', actor)
}

function requirePerson(what: string): Actor {
  const actor = requireActor(what)
  if (actor.type !== 'human') throw new PersonRequiredError(what, actor)
  return actor
}

function sum(rows: readonly { amountMinor: number }[]): number {
  return rows.reduce((total, row) => total + row.amountMinor, 0)
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    legalEntityId: row.legalEntityId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    paidAt: row.paidAt,
    source: row.source,
    reference: row.reference,
    actorType: row.actorType,
    actorId: row.actorId,
  }
}

function toSalesOrder(
  row: SalesOrderRow,
  lines: readonly SalesOrderLineRow[],
  paid: readonly PaymentRow[],
): SalesOrder {
  const paidMinor = sum(paid)
  return {
    id: row.id,
    channel: row.channel,
    channelOrderId: row.channelOrderId,
    contractorId: row.contractorId,
    paymentMethod: row.paymentMethod,
    suggestedEntityId: row.suggestedEntityId,
    legalEntityId: row.legalEntityId,
    entityConfirmedBy:
      row.entityConfirmedByType === null || row.entityConfirmedById === null || row.entityConfirmedAt === null
        ? null
        : { type: row.entityConfirmedByType, id: row.entityConfirmedById, at: row.entityConfirmedAt },
    number: row.number,
    status: row.status,
    currency: row.currency,
    itemsMinor: row.itemsMinor,
    shippingMinor: row.shippingMinor,
    totalMinor: row.totalMinor,
    paidMinor,
    outstandingMinor: Math.max(row.totalMinor - paidMinor, 0),
    delivery: row.delivery,
    deliveryNote: row.deliveryNote,
    trackingReference: row.trackingReference,
    placedAt: row.placedAt,
    lines: lines.map((line) => ({
      position: line.position,
      variantId: line.variantId,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
    })),
    payments: paid.map(toPayment),
  }
}
