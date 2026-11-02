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

export type CustomerResolution =
  | { readonly kind: 'linked'; readonly counterparty: Counterparty }
  | { readonly kind: 'created'; readonly counterparty: Counterparty }
  | { readonly kind: 'suggested'; readonly counterparty: Counterparty }

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
   * The customer behind a channel identity, as far as it can be decided alone.
   *
   * An identity already linked resolves to its customer. One that matches
   * nobody gets a new customer, linked at once - there is nobody it could be
   * confused with. One that matches an existing customer by email or phone is
   * only *suggested*: the channel did not prove the person owns that email, and
   * linking on a match would hand a stranger a wholesale customer's prices and
   * order history. A person confirms the suggestion with `link`.
   */
  async resolve(channel: string, customer: ChannelCustomer): Promise<CustomerResolution> {
    const linked = await this.findLinked(channel, customer.externalId)
    if (linked !== null) return { kind: 'linked', counterparty: linked }

    const matched = await this.match(customer)
    if (matched !== null) return { kind: 'suggested', counterparty: matched }

    const created = await this.create(channel, customer)
    await this.link(channel, customer.externalId, created.id)
    return { kind: 'created', counterparty: created }
  }

  /** Records that a channel identity is this customer. Idempotent. */
  async link(channel: string, externalId: string, counterpartyId: string): Promise<Counterparty> {
    const [party] = await this.db
      .select()
      .from(contractors)
      .where(eq(contractors.id, counterpartyId))
      .limit(1)
    if (party === undefined) throw new Error(`No counterparty ${counterpartyId}`)
    await this.db
      .insert(counterpartyIdentities)
      .values({ channel, externalId, counterpartyId })
      .onConflictDoNothing()
    const linked = await this.findLinked(channel, externalId)
    if (linked === null || linked.id !== counterpartyId) {
      throw new Error(`Identity ${channel}:${externalId} is already linked to another customer`)
    }
    return linked
  }

  /** A new customer for an identity a person decided is nobody we know. */
  async createAndLink(channel: string, customer: ChannelCustomer): Promise<Counterparty> {
    const created = await this.create(channel, customer)
    return await this.link(channel, customer.externalId, created.id)
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
