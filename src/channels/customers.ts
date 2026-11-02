import { and, eq, sql } from 'drizzle-orm'
import { recordChange } from '../change-feed/record.js'
import { normaliseEmail, normalisePhone } from '../contractors/contractors.js'
import { contractors } from '../contractors/schema.js'
import type { Database } from '../db/client.js'
import { type Actor, tryCurrentScope } from '../tenancy/context.js'
import type { ChannelCustomer } from './contract.js'
import { counterpartyIdentities } from './schema.js'

export interface Counterparty {
  readonly id: string
  readonly name: string
  readonly email: string | null
  readonly phone: string | null
  readonly customerGroup: string | null
}

export interface MatchingRules {
  /** Treat an identical email as the same person. */
  readonly byEmail?: boolean
  /** Treat an identical phone number as the same person. */
  readonly byPhone?: boolean
}

const DEFAULT_RULES: Required<MatchingRules> = { byEmail: true, byPhone: true }

/**
 * Ties a channel's customer to the counterparty the core knows.
 *
 * A buyer on a marketplace has no account here, and a wholesale customer must
 * see wholesale prices from their first visit. Both need the same link: the
 * channel's identity on one side, the counterparty and its group on the other.
 */
export class ChannelCustomers {
  constructor(
    private readonly db: Database,
    private readonly rules: MatchingRules = DEFAULT_RULES,
  ) {}

  async findLinked(channel: string, externalId: string): Promise<Counterparty | null> {
    const [row] = await this.db
      .select({ party: contractors })
      .from(counterpartyIdentities)
      .innerJoin(contractors, eq(contractors.id, counterpartyIdentities.counterpartyId))
      .where(
        and(eq(counterpartyIdentities.channel, channel), eq(counterpartyIdentities.externalId, externalId)),
      )
      .limit(1)
    return row === undefined ? null : toCounterparty(row.party)
  }

  /**
   * An existing customer that matches by the configured rules.
   *
   * Email first, compared in lower case. Phone next, compared on digits - but a
   * phone match is only taken when the two records do not disagree about the
   * email: two people sharing a salon's phone are still two people, and merging
   * them would show one the other's orders.
   */
  async match(customer: ChannelCustomer): Promise<Counterparty | null> {
    const email = this.rules.byEmail === false ? null : normaliseEmail(customer.email)
    const phone = this.rules.byPhone === false ? null : normalisePhone(customer.phone)

    if (email !== null) {
      const [byEmail] = await this.db
        .select()
        .from(contractors)
        .where(and(isCustomer, eq(contractors.email, email)))
        .limit(1)
      if (byEmail !== undefined) return toCounterparty(byEmail)
    }
    if (phone !== null) {
      const candidates = await this.db
        .select()
        .from(contractors)
        .where(and(isCustomer, eq(contractors.phone, phone)))
        .limit(2)
      const agreeing = candidates.filter((row) => email === null || row.email === null || row.email === email)
      if (agreeing.length === 1 && agreeing[0] !== undefined) return toCounterparty(agreeing[0])
    }
    return null
  }

  /**
   * The counterparty behind a channel identity, creating one if needed.
   *
   * Always links, even when the counterparty already existed: the next order
   * from that identity must reach the same customer record, or their history
   * and their prices split in two.
   */
  async resolve(channel: string, customer: ChannelCustomer): Promise<Counterparty> {
    const linked = await this.findLinked(channel, customer.externalId)
    if (linked !== null) return linked

    const matched = await this.match(customer)
    const party = matched ?? (await this.create(channel, customer))

    await this.db
      .insert(counterpartyIdentities)
      .values({ channel, externalId: customer.externalId, counterpartyId: party.id })
      .onConflictDoNothing()

    return party
  }

  private async create(channel: string, customer: ChannelCustomer): Promise<Counterparty> {
    const actor: Actor = tryCurrentScope()?.actor ?? { type: 'integration', id: channel }
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(contractors)
        .values({
          name: customer.name ?? customer.email ?? customer.phone ?? 'Unnamed customer',
          roles: ['customer'],
          email: normaliseEmail(customer.email),
          phone: normalisePhone(customer.phone),
          actorType: actor.type,
          actorId: actor.id,
        })
        .returning()
      if (row === undefined) throw new Error('Failed to create counterparty')
      await recordChange(tx, { entityType: 'contractor', entityId: row.id, kind: 'created', actor })
      return toCounterparty(row)
    })
  }

  /** Moves a customer into a group, which changes the prices they see. */
  async setGroup(counterpartyId: string, group: string | null): Promise<Counterparty> {
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(contractors)
        .set({ customerGroup: group, updatedAt: new Date() })
        .where(eq(contractors.id, counterpartyId))
        .returning()
      if (row === undefined) throw new Error(`No counterparty ${counterpartyId}`)
      await recordChange(tx, {
        entityType: 'contractor',
        entityId: row.id,
        kind: 'updated',
        changedFields: ['customerGroup'],
      })
      return toCounterparty(row)
    })
  }

  /** The price list a channel should present to this identity. */
  async priceListFor(channel: string, externalId: string): Promise<string | null> {
    const party = await this.findLinked(channel, externalId)
    return party?.customerGroup ?? null
  }
}

const isCustomer = sql`'customer' = any(${contractors.roles})`

function toCounterparty(row: {
  id: string
  name: string
  email: string | null
  phone: string | null
  customerGroup: string | null
}): Counterparty {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    customerGroup: row.customerGroup,
  }
}
