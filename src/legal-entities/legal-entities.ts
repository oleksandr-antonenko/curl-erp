import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { recordChange } from '../change-feed/record.js'
import type { Executor } from '../change-feed/types.js'
import type { Database } from '../db/client.js'
import { requireActor } from '../tenancy/context.js'
import {
  documentSequences,
  type LegalEntityRow,
  legalEntities,
  legalEntityChanges,
  legalEntityPaymentDefaults,
} from './schema.js'

export class LegalEntityError extends Error {
  override readonly name = 'LegalEntityError'
}

export class LegalEntityNotFoundError extends LegalEntityError {
  constructor(readonly id: string) {
    super(`No legal entity with id ${id}`)
  }
}

export class DuplicateRegistryCodeError extends LegalEntityError {
  constructor(
    readonly registryCode: string,
    readonly heldByName: string,
    readonly heldById: string,
  ) {
    super(`Registry code ${registryCode} already belongs to ${heldByName}`)
  }
}

export class LegalEntityInactiveError extends LegalEntityError {
  constructor(readonly id: string) {
    super(`Legal entity ${id} is deactivated`)
  }
}

/** History points at this entity, so it is deactivated rather than removed. */
export class LegalEntityInUseError extends LegalEntityError {
  constructor(
    readonly id: string,
    readonly heldBy: string,
  ) {
    super(`Legal entity ${id} is referenced by ${heldBy}`)
  }
}

export interface LegalEntityInput {
  readonly name: string
  readonly registryCode: string
  readonly iban?: string
  readonly bankName?: string
}

export interface LegalEntityPatch {
  readonly name?: string
  readonly iban?: string | null
  readonly bankName?: string | null
}

export interface LegalEntity {
  readonly id: string
  readonly name: string
  readonly registryCode: string
  readonly iban: string | null
  readonly bankName: string | null
  readonly isActive: boolean
}

export interface LegalEntityChange {
  readonly field: string
  readonly oldValue: string | null
  readonly newValue: string | null
  readonly actorType: string
  readonly actorId: string
  readonly changedAt: Date
}

/** Anything that can say whether an entity still appears in history. */
export interface LegalEntityReference {
  heldBy(db: Database, legalEntityId: string): Promise<string | null>
}

/**
 * The entity an order should be suggested.
 *
 * The configured default for its payment method, when that entity is still
 * active; otherwise the only active entity, if there is exactly one; otherwise
 * nobody. "Nobody" is a legitimate answer: a person chooses.
 */
export function suggestEntity(input: {
  readonly paymentMethod: string | null
  readonly defaults: ReadonlyMap<string, string>
  readonly activeEntityIds: readonly string[]
}): string | null {
  if (input.paymentMethod !== null) {
    const configured = input.defaults.get(input.paymentMethod)
    if (configured !== undefined && input.activeEntityIds.includes(configured)) return configured
  }
  if (input.activeEntityIds.length === 1) return input.activeEntityIds[0] ?? null
  return null
}

/**
 * Issues the next number of a kind of document for one entity.
 *
 * Must be called inside the transaction that writes the document. The row is
 * locked by the update until that transaction ends, so two confirmations cannot
 * draw the same number, and a rolled-back one returns its number untouched.
 */
export async function nextDocumentNumber(
  executor: Executor,
  legalEntityId: string,
  kind: string,
): Promise<number> {
  const result = await executor.execute<{ issued: number }>(sql`
    insert into ${documentSequences} (legal_entity_id, kind, next_value)
    values (${legalEntityId}, ${kind}, 2)
    on conflict (legal_entity_id, kind)
    do update set next_value = ${documentSequences.nextValue} + 1
    returning next_value - 1 as issued
  `)
  const issued = result.rows[0]?.issued
  if (issued === undefined) throw new LegalEntityError('Failed to issue a document number')
  return Number(issued)
}

/**
 * The legal entities of the current tenant.
 *
 * Works with exactly one: a tenant that never registers a second entity is
 * never asked to choose between them.
 */
export class LegalEntities {
  constructor(
    private readonly db: Database,
    private readonly references: readonly LegalEntityReference[] = [],
  ) {}

  async register(input: LegalEntityInput): Promise<LegalEntity> {
    const name = input.name.trim()
    if (name === '') throw new LegalEntityError('A legal entity needs a name')
    const registryCode = input.registryCode.trim()
    if (registryCode === '') throw new LegalEntityError('A legal entity needs a registry code')

    const [clash] = await this.db
      .select()
      .from(legalEntities)
      .where(eq(legalEntities.registryCode, registryCode))
      .limit(1)
    if (clash !== undefined) throw new DuplicateRegistryCodeError(registryCode, clash.name, clash.id)

    const actor = requireActor('A legal entity')
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(legalEntities)
        .values({
          name,
          registryCode,
          iban: normaliseIban(input.iban),
          bankName: blankToNull(input.bankName),
          actorType: actor.type,
          actorId: actor.id,
        })
        .returning()
      if (row === undefined) throw new LegalEntityError('Failed to record the legal entity')
      await recordChange(tx, { entityType: 'legal_entity', entityId: row.id, kind: 'created' })
      return toLegalEntity(row)
    })
  }

  async find(id: string): Promise<LegalEntity | null> {
    const [row] = await this.db.select().from(legalEntities).where(eq(legalEntities.id, id)).limit(1)
    return row === undefined ? null : toLegalEntity(row)
  }

  /** The entity, insisting it exists and still accepts new documents. */
  async requireActive(id: string): Promise<LegalEntity> {
    const found = await this.find(id)
    if (found === null) throw new LegalEntityNotFoundError(id)
    if (!found.isActive) throw new LegalEntityInactiveError(id)
    return found
  }

  async list(options: { readonly includeInactive?: boolean } = {}): Promise<readonly LegalEntity[]> {
    const rows = await this.db
      .select()
      .from(legalEntities)
      .where(options.includeInactive === true ? undefined : eq(legalEntities.isActive, true))
      .orderBy(asc(legalEntities.name))
    return rows.map(toLegalEntity)
  }

  /** Changes name or bank details, journalling every old and new value. */
  async update(id: string, patch: LegalEntityPatch): Promise<LegalEntity> {
    const actor = requireActor('A change to a legal entity')
    return await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(legalEntities).where(eq(legalEntities.id, id)).for('update')
      if (current === undefined) throw new LegalEntityNotFoundError(id)

      const next = {
        name: patch.name === undefined ? current.name : patch.name.trim(),
        iban: patch.iban === undefined ? current.iban : normaliseIban(patch.iban ?? undefined),
        bankName: patch.bankName === undefined ? current.bankName : blankToNull(patch.bankName ?? undefined),
      }
      if (next.name === '') throw new LegalEntityError('A legal entity needs a name')

      const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
        (field) => next[field] !== current[field],
      )
      if (changed.length === 0) return toLegalEntity(current)

      const [row] = await tx
        .update(legalEntities)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(legalEntities.id, id))
        .returning()
      if (row === undefined) throw new LegalEntityNotFoundError(id)

      await tx.insert(legalEntityChanges).values(
        changed.map((field) => ({
          legalEntityId: id,
          field,
          oldValue: current[field],
          newValue: next[field],
          actorType: actor.type,
          actorId: actor.id,
        })),
      )
      await recordChange(tx, {
        entityType: 'legal_entity',
        entityId: id,
        kind: 'updated',
        changedFields: changed,
      })
      return toLegalEntity(row)
    })
  }

  async changes(id: string): Promise<readonly LegalEntityChange[]> {
    const rows = await this.db
      .select()
      .from(legalEntityChanges)
      .where(eq(legalEntityChanges.legalEntityId, id))
      .orderBy(desc(legalEntityChanges.changedAt))
    return rows.map((row) => ({
      field: row.field,
      oldValue: row.oldValue,
      newValue: row.newValue,
      actorType: row.actorType,
      actorId: row.actorId,
      changedAt: row.changedAt,
    }))
  }

  /** Stops the entity taking new documents; its history stays. */
  async deactivate(id: string): Promise<LegalEntity> {
    return await this.setActive(id, false, 'Deactivating a legal entity')
  }

  /** Lets a deactivated entity take new documents again. */
  async reactivate(id: string): Promise<LegalEntity> {
    return await this.setActive(id, true, 'Reactivating a legal entity')
  }

  private async setActive(id: string, active: boolean, what: string): Promise<LegalEntity> {
    const actor = requireActor(what)
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(legalEntities)
        .set({ isActive: active, updatedAt: new Date() })
        .where(and(eq(legalEntities.id, id), eq(legalEntities.isActive, !active)))
        .returning()
      if (row === undefined) {
        const found = await this.find(id)
        if (found === null) throw new LegalEntityNotFoundError(id)
        return found
      }
      await tx.insert(legalEntityChanges).values({
        legalEntityId: id,
        field: 'isActive',
        oldValue: String(!active),
        newValue: String(active),
        actorType: actor.type,
        actorId: actor.id,
      })
      await recordChange(tx, {
        entityType: 'legal_entity',
        entityId: id,
        kind: 'updated',
        changedFields: ['isActive'],
      })
      return toLegalEntity(row)
    })
  }

  /** Removes an entity that never appeared anywhere; refuses otherwise. */
  async remove(id: string): Promise<void> {
    const found = await this.find(id)
    if (found === null) throw new LegalEntityNotFoundError(id)
    for (const reference of this.references) {
      const heldBy = await reference.heldBy(this.db, id)
      if (heldBy !== null) throw new LegalEntityInUseError(id, heldBy)
    }
    const [journalled] = await this.db
      .select({ id: legalEntityChanges.id })
      .from(legalEntityChanges)
      .where(eq(legalEntityChanges.legalEntityId, id))
      .limit(1)
    if (journalled !== undefined) throw new LegalEntityInUseError(id, 'its change journal')

    await this.db.transaction(async (tx) => {
      await tx.delete(legalEntityPaymentDefaults).where(eq(legalEntityPaymentDefaults.legalEntityId, id))
      await tx.delete(documentSequences).where(eq(documentSequences.legalEntityId, id))
      await tx.delete(legalEntities).where(eq(legalEntities.id, id))
      await recordChange(tx, { entityType: 'legal_entity', entityId: id, kind: 'deleted' })
    })
  }

  /** Names the entity suggested for a payment method, or clears it with null. */
  async setPaymentDefault(paymentMethod: string, legalEntityId: string | null): Promise<void> {
    const method = paymentMethod.trim()
    if (method === '') throw new LegalEntityError('A payment method needs a code')
    if (legalEntityId === null) {
      await this.db
        .delete(legalEntityPaymentDefaults)
        .where(eq(legalEntityPaymentDefaults.paymentMethod, method))
      return
    }
    await this.requireActive(legalEntityId)
    await this.db
      .insert(legalEntityPaymentDefaults)
      .values({ paymentMethod: method, legalEntityId })
      .onConflictDoUpdate({
        target: legalEntityPaymentDefaults.paymentMethod,
        set: { legalEntityId, updatedAt: new Date() },
      })
  }

  async paymentDefaults(): Promise<ReadonlyMap<string, string>> {
    const rows = await this.db.select().from(legalEntityPaymentDefaults)
    return new Map(rows.map((row) => [row.paymentMethod, row.legalEntityId]))
  }

  /** The entity to suggest for an order paid by this method, or null. */
  async suggestFor(paymentMethod: string | null): Promise<string | null> {
    const [defaults, active] = await Promise.all([this.paymentDefaults(), this.list()])
    return suggestEntity({ paymentMethod, defaults, activeEntityIds: active.map((entity) => entity.id) })
  }
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? null : trimmed
}

/** IBANs are printed in groups; stored without spaces, in capitals. */
function normaliseIban(value: string | undefined): string | null {
  const compact = value?.replace(/\s+/g, '').toUpperCase()
  return compact === undefined || compact === '' ? null : compact
}

function toLegalEntity(row: LegalEntityRow): LegalEntity {
  return {
    id: row.id,
    name: row.name,
    registryCode: row.registryCode,
    iban: row.iban,
    bankName: row.bankName,
    isActive: row.isActive,
  }
}
