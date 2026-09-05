import { and, eq, or } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import type { ChannelCustomer } from './contract.js'
import { counterparties, counterpartyIdentities } from './schema.js'

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

/** Digits only, so `+380 (44) 123` and `380441 23` are the same number. */
function normalisePhone(phone: string | undefined): string | null {
  if (phone === undefined) return null
  const digits = phone.replace(/\D/g, '')
  return digits === '' ? null : digits
}

function normaliseEmail(email: string | undefined): string | null {
  const trimmed = email?.trim().toLowerCase()
  return trimmed === undefined || trimmed === '' ? null : trimmed
}

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
      .select({ party: counterparties })
      .from(counterpartyIdentities)
      .innerJoin(counterparties, eq(counterparties.id, counterpartyIdentities.counterpartyId))
      .where(
        and(eq(counterpartyIdentities.channel, channel), eq(counterpartyIdentities.externalId, externalId)),
      )
      .limit(1)
    return row === undefined ? null : toCounterparty(row.party)
  }

  /** An existing counterparty that matches by the configured rules. */
  async match(customer: ChannelCustomer): Promise<Counterparty | null> {
    const email = this.rules.byEmail === false ? null : normaliseEmail(customer.email)
    const phone = this.rules.byPhone === false ? null : normalisePhone(customer.phone)
    if (email === null && phone === null) return null

    const conditions = [
      email === null ? undefined : eq(counterparties.email, email),
      phone === null ? undefined : eq(counterparties.phone, phone),
    ].filter((condition) => condition !== undefined)

    const [row] = await this.db
      .select()
      .from(counterparties)
      .where(conditions.length === 1 ? conditions[0] : or(...conditions))
      .limit(1)
    return row === undefined ? null : toCounterparty(row)
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
    const party = matched ?? (await this.create(customer))

    await this.db
      .insert(counterpartyIdentities)
      .values({ channel, externalId: customer.externalId, counterpartyId: party.id })
      .onConflictDoNothing()

    return party
  }

  private async create(customer: ChannelCustomer): Promise<Counterparty> {
    const [row] = await this.db
      .insert(counterparties)
      .values({
        name: customer.name ?? customer.email ?? customer.phone ?? 'Unnamed customer',
        email: normaliseEmail(customer.email),
        phone: normalisePhone(customer.phone),
      })
      .returning()
    if (row === undefined) throw new Error('Failed to create counterparty')
    return toCounterparty(row)
  }

  /** Moves a counterparty into a group, which changes the prices they see. */
  async setGroup(counterpartyId: string, group: string | null): Promise<Counterparty> {
    const [row] = await this.db
      .update(counterparties)
      .set({ customerGroup: group, updatedAt: new Date() })
      .where(eq(counterparties.id, counterpartyId))
      .returning()
    if (row === undefined) throw new Error(`No counterparty ${counterpartyId}`)
    return toCounterparty(row)
  }

  /** The price list a channel should present to this identity. */
  async priceListFor(channel: string, externalId: string): Promise<string | null> {
    const party = await this.findLinked(channel, externalId)
    return party?.customerGroup ?? null
  }
}

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
