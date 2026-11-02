import { and, eq, or, sql } from 'drizzle-orm'
import { recordChange } from '../change-feed/record.js'
import type { Database } from '../db/client.js'
import { requireActor } from '../tenancy/context.js'
import { CONTRACTOR_ROLES, type ContractorRole, type ContractorRow, contractors } from './schema.js'

export class ContractorError extends Error {
  override readonly name = 'ContractorError'
}

/** A tax identifier already belongs to somebody in this tenant. */
export class DuplicateIdentityError extends ContractorError {
  constructor(
    readonly field: string,
    readonly value: string,
    readonly heldByName: string,
    readonly heldById: string,
  ) {
    super(`${field} "${value}" already belongs to ${heldByName}`)
  }
}

export class ContractorNotFoundError extends ContractorError {
  constructor(readonly id: string) {
    super(`No contractor with id ${id}`)
  }
}

/** The contractor does not play the role this document needs it to play. */
export class RoleNotPlayedError extends ContractorError {
  constructor(
    readonly id: string,
    readonly role: ContractorRole,
  ) {
    super(`Contractor ${id} does not act as ${role}`)
  }
}

/** History points at this contractor, so it is deactivated rather than removed. */
export class ContractorInUseError extends ContractorError {
  constructor(
    readonly id: string,
    readonly heldBy: string,
  ) {
    super(`Contractor ${id} is referenced by ${heldBy}`)
  }
}

export interface ContractorInput {
  readonly name: string
  readonly registryCode?: string
  readonly taxCode?: string
  readonly roles: readonly ContractorRole[]
  readonly note?: string
}

export interface Contractor {
  readonly id: string
  readonly name: string
  readonly registryCode: string | null
  readonly taxCode: string | null
  readonly roles: readonly ContractorRole[]
  readonly isActive: boolean
  readonly note: string | null
  readonly email: string | null
  readonly phone: string | null
  readonly customerGroup: string | null
}

/** How to reach a customer, and which prices they are quoted. */
export interface ContractorContactPatch {
  readonly name?: string
  readonly email?: string | null
  readonly phone?: string | null
  readonly customerGroup?: string | null
}

/** Anything that can say whether a contractor still appears in history. */
export interface ContractorReference {
  heldBy(db: Database, contractorId: string): Promise<string | null>
}

/**
 * Who we buy from and sell to.
 *
 * A tax identifier is unique within the tenant and not beyond it: two
 * businesses running on this ERP may buy from the same supplier, and a global
 * index would leave the second unable to record its own purchases.
 */
export class Contractors {
  constructor(
    private readonly db: Database,
    private readonly references: readonly ContractorReference[] = [],
  ) {}

  async create(input: ContractorInput): Promise<Contractor> {
    const name = input.name.trim()
    if (name === '') throw new ContractorError('A contractor needs a name')
    if (input.roles.length === 0) throw new ContractorError('A contractor needs at least one role')
    for (const role of input.roles) {
      if (!CONTRACTOR_ROLES.includes(role)) throw new ContractorError(`Unknown role "${role}"`)
    }

    const registryCode = blankToNull(input.registryCode)
    const taxCode = blankToNull(input.taxCode)
    await this.guardIdentity({ registryCode, taxCode })

    const actor = requireActor('A contractor')
    const [row] = await this.db
      .insert(contractors)
      .values({
        name,
        registryCode,
        taxCode,
        roles: [...input.roles],
        note: blankToNull(input.note),
        actorType: actor.type,
        actorId: actor.id,
      })
      .returning()
    if (row === undefined) throw new ContractorError('Failed to record the contractor')
    return toContractor(row)
  }

  async find(id: string): Promise<Contractor | null> {
    const [row] = await this.db.select().from(contractors).where(eq(contractors.id, id)).limit(1)
    return row === undefined ? null : toContractor(row)
  }

  /**
   * The contractor, insisting it plays this role.
   *
   * Used by documents rather than a plain lookup, so that recording a purchase
   * from somebody who is only ever a customer fails at the document instead of
   * quietly producing a supplier out of them.
   */
  async require(id: string, role: ContractorRole): Promise<Contractor> {
    const found = await this.find(id)
    if (found === null) throw new ContractorNotFoundError(id)
    if (!found.roles.includes(role)) throw new RoleNotPlayedError(id, role)
    return found
  }

  async list(
    options: { readonly role?: ContractorRole; readonly includeInactive?: boolean } = {},
  ): Promise<readonly Contractor[]> {
    const conditions = []
    if (options.includeInactive !== true) conditions.push(eq(contractors.isActive, true))
    if (options.role !== undefined) {
      conditions.push(sql`${options.role} = any(${contractors.roles})`)
    }
    const rows = await this.db
      .select()
      .from(contractors)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(contractors.name)
    return rows.map(toContractor)
  }

  /**
   * Changes a customer's name, contact details or group.
   *
   * The change feed is told which fields changed and never their values:
   * marketplaces and the search index read that feed, and a phone number or an
   * email address must not reach either.
   */
  async updateContact(id: string, patch: ContractorContactPatch): Promise<Contractor> {
    return await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(contractors).where(eq(contractors.id, id)).for('update')
      if (current === undefined) throw new ContractorNotFoundError(id)

      const next = {
        name: patch.name === undefined ? current.name : patch.name.trim(),
        email: patch.email === undefined ? current.email : normaliseEmail(patch.email),
        phone: patch.phone === undefined ? current.phone : normalisePhone(patch.phone),
        customerGroup: patch.customerGroup === undefined ? current.customerGroup : patch.customerGroup,
      }
      if (next.name === '') throw new ContractorError('A contractor needs a name')
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
        (field) => next[field] !== current[field],
      )
      if (changed.length === 0) return toContractor(current)

      const [row] = await tx
        .update(contractors)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(contractors.id, id))
        .returning()
      if (row === undefined) throw new ContractorNotFoundError(id)
      await recordChange(tx, {
        entityType: 'contractor',
        entityId: id,
        kind: 'updated',
        changedFields: changed,
      })
      return toContractor(row)
    })
  }

  async deactivate(id: string): Promise<Contractor> {
    const [row] = await this.db
      .update(contractors)
      .set({ isActive: false })
      .where(eq(contractors.id, id))
      .returning()
    if (row === undefined) throw new ContractorNotFoundError(id)
    return toContractor(row)
  }

  /**
   * Removes a contractor that never appeared anywhere.
   *
   * Refuses as soon as any document cites it, and the caller is expected to
   * deactivate instead: a supplier with history is part of the record of what
   * happened, whether or not we still buy from them.
   */
  async remove(id: string): Promise<void> {
    const found = await this.find(id)
    if (found === null) throw new ContractorNotFoundError(id)

    for (const reference of this.references) {
      const heldBy = await reference.heldBy(this.db, id)
      if (heldBy !== null) throw new ContractorInUseError(id, heldBy)
    }
    await this.db.delete(contractors).where(eq(contractors.id, id))
  }

  private async guardIdentity(identity: {
    readonly registryCode: string | null
    readonly taxCode: string | null
  }): Promise<void> {
    const checks = []
    if (identity.registryCode !== null) checks.push(eq(contractors.registryCode, identity.registryCode))
    if (identity.taxCode !== null) checks.push(eq(contractors.taxCode, identity.taxCode))
    if (checks.length === 0) return

    const [clash] = await this.db
      .select()
      .from(contractors)
      .where(or(...checks))
      .limit(1)
    if (clash === undefined) return

    const field =
      identity.registryCode !== null && clash.registryCode === identity.registryCode
        ? 'registryCode'
        : 'taxCode'
    const value = field === 'registryCode' ? identity.registryCode : identity.taxCode
    throw new DuplicateIdentityError(field, value ?? '', clash.name, clash.id)
  }
}

/** Lower case, so `Olga@Salon.UA` and `olga@salon.ua` are one address. */
export function normaliseEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase()
  return trimmed === undefined || trimmed === '' ? null : trimmed
}

/** Digits only, so `+38 (067) 123-45-67` and `380671234567` are one number. */
export function normalisePhone(phone: string | null | undefined): string | null {
  const digits = phone?.replace(/\D/g, '') ?? ''
  return digits === '' ? null : digits
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? null : trimmed
}

function toContractor(row: ContractorRow): Contractor {
  return {
    id: row.id,
    name: row.name,
    registryCode: row.registryCode,
    taxCode: row.taxCode,
    roles: row.roles as ContractorRole[],
    isActive: row.isActive,
    note: row.note,
    email: row.email,
    phone: row.phone,
    customerGroup: row.customerGroup,
  }
}
