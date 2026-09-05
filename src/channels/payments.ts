import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { ChannelOutbound } from './outbound.js'
import { channelPayments } from './schema.js'

export interface PaymentNotification {
  readonly channel: string
  readonly externalOrderId: string
  /** The provider's own identifier. Repeats must not be counted twice. */
  readonly reference: string
  readonly amountMinor: number
  readonly currency: string
  readonly paidAt: Date
  readonly payload?: Record<string, unknown>
}

export interface PaymentRecord {
  readonly reference: string
  readonly externalOrderId: string
  readonly amountMinor: number
  readonly currency: string
  readonly paidAt: Date
}

export interface RecordResult {
  readonly recorded: boolean
  /** True when this notification had already been seen. */
  readonly duplicate: boolean
}

export interface PaymentMismatch {
  readonly externalOrderId: string
  readonly claimedByChannel: boolean
  readonly recordedInCore: boolean
}

/**
 * The money side of a channel.
 *
 * A channel may report that an order is paid; that report is never accepted as
 * the fact. Money enters the core only through a payment notification recorded
 * here, and the order's paid status is then published outward. Otherwise the
 * books and the shop keep two different answers to the same question, and only
 * one of them is the one the bank agrees with.
 */
export class ChannelPayments {
  private readonly outbound: ChannelOutbound

  constructor(private readonly db: Database) {
    this.outbound = new ChannelOutbound(db)
  }

  /** Records a payment once. A repeat of the same reference changes nothing. */
  async record(notification: PaymentNotification): Promise<RecordResult> {
    const inserted = await this.db
      .insert(channelPayments)
      .values({
        channel: notification.channel,
        externalOrderId: notification.externalOrderId,
        reference: notification.reference,
        amountMinor: notification.amountMinor,
        currency: notification.currency,
        paidAt: notification.paidAt,
        payload: notification.payload ?? null,
      })
      .onConflictDoNothing({
        target: [channelPayments.channel, channelPayments.reference],
      })
      .returning({ id: channelPayments.id })

    if (inserted.length === 0) return { recorded: false, duplicate: true }

    // Only now is the channel told, and only by us.
    await this.outbound.enqueue(notification.channel, 'order_status', notification.externalOrderId, {
      externalOrderId: notification.externalOrderId,
      status: 'paid',
    })
    return { recorded: true, duplicate: false }
  }

  async paymentsFor(channel: string, externalOrderId: string): Promise<PaymentRecord[]> {
    const rows = await this.db
      .select()
      .from(channelPayments)
      .where(and(eq(channelPayments.channel, channel), eq(channelPayments.externalOrderId, externalOrderId)))
    return rows.map((row) => ({
      reference: row.reference,
      externalOrderId: row.externalOrderId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      paidAt: row.paidAt,
    }))
  }

  /** Total actually received for an order, in minor units. */
  async totalPaidMinor(channel: string, externalOrderId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${channelPayments.amountMinor}), 0)::text` })
      .from(channelPayments)
      .where(and(eq(channelPayments.channel, channel), eq(channelPayments.externalOrderId, externalOrderId)))
    return Number(row?.total ?? 0)
  }

  async isPaid(channel: string, externalOrderId: string): Promise<boolean> {
    return (await this.paymentsFor(channel, externalOrderId)).length > 0
  }

  /**
   * Checks a channel's claim against what the core actually received.
   *
   * A claim with nothing behind it is reported rather than believed: it is
   * either a channel bug or an unrecorded payment, and both need a person.
   */
  async checkClaim(
    channel: string,
    externalOrderId: string,
    channelSaysPaid: boolean,
  ): Promise<PaymentMismatch | null> {
    const recorded = await this.isPaid(channel, externalOrderId)
    if (recorded === channelSaysPaid) return null
    return { externalOrderId, claimedByChannel: channelSaysPaid, recordedInCore: recorded }
  }
}
