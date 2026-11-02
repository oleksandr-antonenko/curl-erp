import { and, eq, isNull } from 'drizzle-orm'
import { contractors } from '../contractors/schema.js'
import type { Database } from '../db/client.js'
import type { ChannelCustomerGroupMembership, SalesChannelAdapter } from './contract.js'
import { ChannelOutbound } from './outbound.js'
import { channelDrift, counterpartyIdentities } from './schema.js'

export interface GroupReconciliation {
  readonly checked: number
  readonly corrected: number
}

/**
 * Keeps each channel's idea of a customer's group equal to the core's.
 *
 * The core decides who is quoted wholesale. A channel that lets staff put a
 * customer into a group by hand would otherwise grow a second answer, and the
 * one a customer sees would be whichever was edited last. Only customers
 * linked to a channel identity are projected: an imported customer who never
 * used the shop is not copied anywhere.
 */
export class ChannelCustomerGroups {
  private readonly outbound: ChannelOutbound

  constructor(private readonly db: Database) {
    this.outbound = new ChannelOutbound(db)
  }

  /** Queues the customer's current group to every channel they are linked on. */
  async project(contractorId: string): Promise<number> {
    const rows = await this.db
      .select({
        channel: counterpartyIdentities.channel,
        externalId: counterpartyIdentities.externalId,
        group: contractors.customerGroup,
      })
      .from(counterpartyIdentities)
      .innerJoin(contractors, eq(contractors.id, counterpartyIdentities.counterpartyId))
      .where(eq(counterpartyIdentities.counterpartyId, contractorId))
    for (const row of rows) {
      const membership: ChannelCustomerGroupMembership = {
        externalCustomerId: row.externalId,
        group: row.group,
      }
      await this.outbound.enqueue(row.channel, 'customer_group', row.externalId, { ...membership })
    }
    return rows.length
  }

  /**
   * Compares what the channel holds with the core, corrects every difference
   * and records it in the drift report.
   */
  async reconcile(channel: string, adapter: SalesChannelAdapter): Promise<GroupReconciliation> {
    if (adapter.fetchCustomerGroups === undefined || adapter.publishCustomerGroups === undefined) {
      return { checked: 0, corrected: 0 }
    }
    const linked = await this.db
      .select({ externalId: counterpartyIdentities.externalId, group: contractors.customerGroup })
      .from(counterpartyIdentities)
      .innerJoin(contractors, eq(contractors.id, counterpartyIdentities.counterpartyId))
      .where(eq(counterpartyIdentities.channel, channel))
    if (linked.length === 0) return { checked: 0, corrected: 0 }

    const reported = new Map(
      (await adapter.fetchCustomerGroups(linked.map((row) => row.externalId))).map((row) => [
        row.externalCustomerId,
        row.group,
      ]),
    )
    const corrections: ChannelCustomerGroupMembership[] = []
    for (const row of linked) {
      const actual = reported.get(row.externalId) ?? null
      if (actual === row.group) continue
      corrections.push({ externalCustomerId: row.externalId, group: row.group })
      await this.db.insert(channelDrift).values({
        channel,
        kind: 'customer_group',
        subject: row.externalId,
        expected: row.group,
        actual,
      })
    }
    if (corrections.length > 0) await adapter.publishCustomerGroups(corrections)
    return { checked: linked.length, corrected: corrections.length }
  }

  /** Open group drift for a channel, oldest first. */
  async openDrift(channel: string) {
    return await this.db
      .select()
      .from(channelDrift)
      .where(
        and(
          eq(channelDrift.channel, channel),
          eq(channelDrift.kind, 'customer_group'),
          isNull(channelDrift.resolvedAt),
        ),
      )
  }
}
