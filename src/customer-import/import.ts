import { and, eq, inArray, sql } from 'drizzle-orm'
import { ImportError, ProposalNotApplicableError } from '../catalog-import/errors.js'
import { recordChange } from '../change-feed/record.js'
import { normaliseEmail, normalisePhone } from '../contractors/contractors.js'
import { contractorAddresses, contractorLegacyIds, contractors } from '../contractors/schema.js'
import type { Database } from '../db/client.js'
import { requireActor, tryCurrentScope } from '../tenancy/context.js'
import type { LegacyAddress, LegacyCustomer, LegacyCustomerReader } from './contract.js'
import { customerImports } from './schema.js'
import type {
  CustomerImportProposal,
  CustomerImportReport,
  GroupReconciliation,
  ProposedCustomer,
  ProposedCustomerAction,
} from './types.js'

export interface CustomerImportOptions {
  /**
   * Which group wins for a customer the source put in several, highest first.
   * A group not listed ranks below every listed one; "no group" ranks last.
   */
  readonly groupPrecedence?: readonly string[]
}

/** One person: every source record sharing an email, or a record of its own. */
interface Person {
  readonly records: readonly LegacyCustomer[]
  readonly email: string | null
  readonly phone: string | null
  readonly name: string
}

/**
 * Moves customers off a previous system.
 *
 * Propose first, apply second, exactly as the catalog import does - a wrong
 * group here quotes a hairdresser retail prices, or a stranger wholesale ones.
 */
export class CustomerImport {
  private readonly addressSource: string

  constructor(
    private readonly db: Database,
    private readonly reader: LegacyCustomerReader,
    private readonly options: CustomerImportOptions = {},
  ) {
    this.addressSource = `${reader.sourceName}:address`
  }

  // --- proposing -----------------------------------------------------------

  /** Works out what would change. Writes the proposal and nothing else. */
  async propose(): Promise<{ id: string; proposal: CustomerImportProposal }> {
    const [records, addresses, mapping] = await Promise.all([
      this.reader.readCustomers(),
      this.reader.readAddresses(),
      this.reader.groupMapping(),
    ])

    const customers: ProposedCustomer[] = []
    const unmappedGroups: { legacyId: string; groups: string[] }[] = []
    const eligible: LegacyCustomer[] = []

    for (const record of records) {
      const reason = refusalOf(record)
      if (reason !== null) {
        customers.push({
          legacyIds: [record.legacyId],
          action: 'refuse',
          reason,
          group: null,
          addressCount: 0,
        })
        continue
      }
      eligible.push(record)
    }

    const people = groupIntoPeople(eligible)
    for (const person of people) {
      const groupDecision = this.decideGroup(person, mapping)
      if (groupDecision.unmapped.length > 0) {
        unmappedGroups.push({ legacyId: primaryId(person), groups: groupDecision.unmapped })
      }
      const existing = await this.findExisting(person)
      const ids = person.records.map((record) => record.legacyId)
      const addressCount = addresses.filter(
        (address) => !address.deleted && ids.includes(address.customerLegacyId),
      ).length

      customers.push({
        legacyIds: ids,
        action: existing === null ? 'create' : 'update',
        group: groupDecision.group,
        ...(groupDecision.among.length > 1
          ? { groupChoice: { among: groupDecision.among, chose: groupDecision.group } }
          : {}),
        ...(existing === null ? {} : { changedFields: changedFields(existing, person, groupDecision.group) }),
        addressCount,
      })
    }

    const proposal: CustomerImportProposal = {
      source: this.reader.sourceName,
      sourceRecords: records.length,
      customers,
      counts: tally(customers),
      possibleDuplicates: possibleDuplicates(people),
      unmappedGroups,
    }

    const actor = tryCurrentScope()?.actor ?? null
    const [row] = await this.db
      .insert(customerImports)
      .values({
        source: this.reader.sourceName,
        proposedBy: actor?.id ?? null,
        proposedByName: actor?.displayName ?? null,
        sourceRecords: records.length,
        proposal,
      })
      .returning({ id: customerImports.id })
    if (row === undefined) throw new ImportError('Failed to store the proposal')
    return { id: row.id, proposal }
  }

  // --- applying ------------------------------------------------------------

  async apply(importId: string): Promise<CustomerImportReport> {
    const [run] = await this.db
      .select()
      .from(customerImports)
      .where(eq(customerImports.id, importId))
      .limit(1)
    if (run === undefined) throw new ImportError(`No customer import ${importId}`)
    if (run.state === 'applied') {
      throw new ProposalNotApplicableError(
        run.state,
        'This proposal was already applied; propose again to import current data',
      )
    }
    requireActor('A customer import')

    const proposal = run.proposal as CustomerImportProposal
    const [records, addresses] = await Promise.all([this.reader.readCustomers(), this.reader.readAddresses()])
    const byLegacyId = new Map(records.map((record) => [record.legacyId, record]))

    const refusals: { legacyId: string; reason: string }[] = []
    const merges: { into: string; absorbed: string[] }[] = []
    const appliedIds = new Map<string, string>()
    let imported = 0
    let merged = 0
    let skipped = 0
    let failed = 0

    for (const proposed of proposal.customers) {
      if (proposed.action === 'refuse') {
        skipped += proposed.legacyIds.length
        for (const legacyId of proposed.legacyIds) {
          refusals.push({ legacyId, reason: proposed.reason ?? 'refused' })
        }
        continue
      }
      const sourceRecords = proposed.legacyIds
        .map((legacyId) => byLegacyId.get(legacyId))
        .filter((record): record is LegacyCustomer => record !== undefined)
      if (sourceRecords.length !== proposed.legacyIds.length) {
        failed += proposed.legacyIds.length
        for (const legacyId of proposed.legacyIds) {
          refusals.push({ legacyId, reason: 'no longer present in the source' })
        }
        continue
      }

      try {
        const contractorId = await this.applyOne(personOf(sourceRecords), proposed.group)
        for (const legacyId of proposed.legacyIds) appliedIds.set(legacyId, contractorId)
        imported += 1
        if (proposed.legacyIds.length > 1) {
          merged += proposed.legacyIds.length - 1
          merges.push({ into: proposed.legacyIds[0] ?? '', absorbed: proposed.legacyIds.slice(1) })
        }
      } catch (error) {
        failed += proposed.legacyIds.length
        for (const legacyId of proposed.legacyIds) {
          refusals.push({ legacyId, reason: error instanceof Error ? safeReason(error.message) : 'failed' })
        }
      }
    }

    const addressOutcome = await this.applyAddresses(addresses, appliedIds, byLegacyId)
    const groups = await this.reconcileGroups(proposal)
    const reconciles = imported + merged + skipped + failed === proposal.sourceRecords
    const groupGap = groups.find((group) => group.source !== group.imported)

    const needsAttention = !reconciles
      ? `counts do not reconcile: ${String(imported + merged + skipped + failed)} of ${String(proposal.sourceRecords)}`
      : groupGap !== undefined
        ? `group ${groupGap.group}: ${String(groupGap.source)} in the source, ${String(groupGap.imported)} imported`
        : null

    const report: CustomerImportReport = {
      source: this.reader.sourceName,
      sourceRecords: proposal.sourceRecords,
      imported,
      merged,
      skipped,
      failed,
      refusals,
      merges,
      possibleDuplicates: proposal.possibleDuplicates,
      groups,
      groupChoices: proposal.customers
        .filter((customer) => customer.groupChoice !== undefined)
        .map((customer) => ({
          legacyId: customer.legacyIds[0] ?? '',
          among: customer.groupChoice?.among ?? [],
          chose: customer.groupChoice?.chose ?? null,
        })),
      unmappedGroups: proposal.unmappedGroups,
      addresses: addressOutcome,
      needsAttention,
    }

    const actor = tryCurrentScope()?.actor ?? null
    await this.db
      .update(customerImports)
      .set({
        state: 'applied',
        appliedAt: new Date(),
        appliedBy: actor?.id ?? null,
        appliedByName: actor?.displayName ?? null,
        imported,
        merged,
        skipped,
        failed,
        report,
        needsAttention,
      })
      .where(eq(customerImports.id, importId))
    return report
  }

  async runById(importId: string): Promise<typeof customerImports.$inferSelect | null> {
    const [run] = await this.db
      .select()
      .from(customerImports)
      .where(eq(customerImports.id, importId))
      .limit(1)
    return run ?? null
  }

  /** Creates or updates the one contractor a person becomes. Returns its id. */
  private async applyOne(person: Person, group: string | null): Promise<string> {
    const actor = requireActor('A customer import')
    const existing = await this.findExisting(person)
    const source = this.reader.sourceName

    return await this.db.transaction(async (tx) => {
      let contractorId: string
      if (existing === null) {
        const [row] = await tx
          .insert(contractors)
          .values({
            name: person.name,
            roles: ['customer'],
            email: person.email,
            phone: person.phone,
            customerGroup: group,
            actorType: actor.type,
            actorId: actor.id,
          })
          .returning({ id: contractors.id })
        if (row === undefined) throw new ImportError('Failed to create the customer')
        contractorId = row.id
        await recordChange(tx, { entityType: 'contractor', entityId: contractorId, kind: 'created' })
      } else {
        contractorId = existing.id
        const changed = changedFields(existing, person, group)
        const roles = existing.roles.includes('customer') ? existing.roles : [...existing.roles, 'customer']
        if (changed.length > 0 || roles !== existing.roles) {
          await tx
            .update(contractors)
            .set({
              name: person.name,
              email: person.email ?? existing.email,
              phone: person.phone ?? existing.phone,
              customerGroup: group,
              roles,
              updatedAt: new Date(),
            })
            .where(eq(contractors.id, contractorId))
          await recordChange(tx, {
            entityType: 'contractor',
            entityId: contractorId,
            kind: 'updated',
            changedFields: changed.length > 0 ? changed : ['roles'],
          })
        }
      }

      await tx
        .insert(contractorLegacyIds)
        .values(person.records.map((record) => ({ source, legacyId: record.legacyId, contractorId })))
        .onConflictDoNothing()
      return contractorId
    })
  }

  private async applyAddresses(
    addresses: readonly LegacyAddress[],
    appliedIds: ReadonlyMap<string, string>,
    byLegacyId: ReadonlyMap<string, LegacyCustomer>,
  ): Promise<CustomerImportReport['addresses']> {
    const skipped: { legacyId: string; reason: string }[] = []
    let imported = 0

    const known = new Set(
      (
        await this.db
          .select({ legacyId: contractorLegacyIds.legacyId })
          .from(contractorLegacyIds)
          .where(eq(contractorLegacyIds.source, this.addressSource))
      ).map((row) => row.legacyId),
    )

    for (const address of addresses) {
      if (address.deleted) {
        skipped.push({ legacyId: address.legacyId, reason: 'deleted in source' })
        continue
      }
      const contractorId = appliedIds.get(address.customerLegacyId)
      if (contractorId === undefined) {
        const owner = byLegacyId.get(address.customerLegacyId)
        const why =
          owner === undefined
            ? 'its customer is not in the source'
            : `its customer ${owner.legacyId} was not imported`
        skipped.push({ legacyId: address.legacyId, reason: why })
        continue
      }
      if (address.addressText.trim() === '') {
        skipped.push({ legacyId: address.legacyId, reason: 'empty address' })
        continue
      }
      if (known.has(address.legacyId)) {
        imported += 1
        continue
      }
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(contractorAddresses)
          .values({
            contractorId,
            recipientName: blankToNull(address.recipientName),
            phone: normalisePhone(address.phone),
            city: blankToNull(address.city),
            addressText: address.addressText.trim(),
          })
          .returning({ id: contractorAddresses.id })
        if (row === undefined) throw new ImportError('Failed to store an address')
        await tx.insert(contractorLegacyIds).values({
          source: this.addressSource,
          legacyId: address.legacyId,
          contractorId,
          addressId: row.id,
        })
      })
      imported += 1
    }
    return { imported, skipped }
  }

  private async reconcileGroups(proposal: CustomerImportProposal): Promise<GroupReconciliation[]> {
    const expected = new Map<string, number>()
    for (const customer of proposal.customers) {
      if (customer.action === 'refuse' || customer.group === null) continue
      expected.set(customer.group, (expected.get(customer.group) ?? 0) + 1)
    }
    const result: GroupReconciliation[] = []
    for (const [group, count] of [...expected.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const rows = await this.db.execute<{ n: number }>(sql`
        select count(distinct c.id)::int as n from ${contractors} c
        join ${contractorLegacyIds} l on l.contractor_id = c.id and l.source = ${this.reader.sourceName}
        where c.customer_group = ${group}
      `)
      result.push({ group, source: count, imported: Number(rows.rows[0]?.n ?? 0) })
    }
    return result
  }

  /** A contractor this person already is: by previous id, then by email. */
  private async findExisting(person: Person): Promise<typeof contractors.$inferSelect | null> {
    const ids = person.records.map((record) => record.legacyId)
    const [byLegacy] = await this.db
      .select({ contractor: contractors })
      .from(contractorLegacyIds)
      .innerJoin(contractors, eq(contractors.id, contractorLegacyIds.contractorId))
      .where(
        and(
          eq(contractorLegacyIds.source, this.reader.sourceName),
          inArray(contractorLegacyIds.legacyId, ids),
        ),
      )
      .limit(1)
    if (byLegacy !== undefined) return byLegacy.contractor
    if (person.email === null) return null
    const [byEmail] = await this.db
      .select()
      .from(contractors)
      .where(and(eq(contractors.email, person.email), sql`'customer' = any(${contractors.roles})`))
      .limit(1)
    return byEmail ?? null
  }

  private decideGroup(
    person: Person,
    mapping: Readonly<Record<string, string | null>>,
  ): { group: string | null; among: (string | null)[]; unmapped: string[] } {
    const unmapped: string[] = []
    const mapped = new Set<string | null>()
    for (const record of person.records) {
      for (const sourceGroup of record.groups) {
        if (!(sourceGroup in mapping)) {
          unmapped.push(sourceGroup)
          continue
        }
        mapped.add(mapping[sourceGroup] ?? null)
      }
    }
    const among = [...mapped]
    const precedence = this.options.groupPrecedence ?? []
    const rank = (group: string | null): number => {
      if (group === null) return Number.MAX_SAFE_INTEGER
      const index = precedence.indexOf(group)
      return index === -1 ? precedence.length : index
    }
    const group = among.length === 0 ? null : ([...among].sort((a, b) => rank(a) - rank(b))[0] ?? null)
    return { group, among, unmapped: [...new Set(unmapped)] }
  }
}

function refusalOf(record: LegacyCustomer): string | null {
  if (record.deleted) return 'deleted in source'
  if (record.guest) return 'guest checkout, not an account'
  return null
}

/** Records sharing an email (in any case) are one person; the rest stand alone. */
function groupIntoPeople(records: readonly LegacyCustomer[]): Person[] {
  const byEmail = new Map<string, LegacyCustomer[]>()
  const alone: LegacyCustomer[][] = []
  for (const record of [...records].sort(byLegacyOrder)) {
    const email = normaliseEmail(record.email)
    if (email === null) {
      alone.push([record])
      continue
    }
    const list = byEmail.get(email) ?? []
    list.push(record)
    byEmail.set(email, list)
  }
  return [...byEmail.values(), ...alone].map(personOf)
}

function personOf(records: readonly LegacyCustomer[]): Person {
  const sorted = [...records].sort(byLegacyOrder)
  const primary = sorted[0]
  if (primary === undefined) throw new ImportError('A person needs a record')
  const phone = sorted.map((record) => normalisePhone(record.phone)).find((value) => value !== null) ?? null
  return { records: sorted, email: normaliseEmail(primary.email), phone, name: nameOf(primary) }
}

function nameOf(record: LegacyCustomer): string {
  const person = [record.firstName, record.lastName]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
  const company = record.company?.trim() ?? ''
  if (person !== '' && company !== '') return `${person} (${company})`
  if (person !== '') return person
  if (company !== '') return company
  return `Customer ${record.legacyId}`
}

function primaryId(person: Person): string {
  return person.records[0]?.legacyId ?? ''
}

/** Numeric ids in numeric order, others after, so the oldest account leads. */
function byLegacyOrder(a: LegacyCustomer, b: LegacyCustomer): number {
  const x = Number(a.legacyId)
  const y = Number(b.legacyId)
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y
  return a.legacyId.localeCompare(b.legacyId)
}

function changedFields(
  existing: typeof contractors.$inferSelect,
  person: Person,
  group: string | null,
): string[] {
  const changed: string[] = []
  if (existing.name !== person.name) changed.push('name')
  if (person.email !== null && existing.email !== person.email) changed.push('email')
  if (person.phone !== null && existing.phone !== person.phone) changed.push('phone')
  if (existing.customerGroup !== group) changed.push('customerGroup')
  return changed
}

function possibleDuplicates(people: readonly Person[]): [string, string][] {
  const byPhone = new Map<string, Person[]>()
  for (const person of people) {
    if (person.phone === null) continue
    const list = byPhone.get(person.phone) ?? []
    list.push(person)
    byPhone.set(person.phone, list)
  }
  const pairs: [string, string][] = []
  for (const list of byPhone.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]
        const b = list[j]
        if (a === undefined || b === undefined || a.email === b.email) continue
        pairs.push([primaryId(a), primaryId(b)])
      }
    }
  }
  return pairs
}

function tally(customers: readonly ProposedCustomer[]): Record<ProposedCustomerAction, number> {
  const counts: Record<ProposedCustomerAction, number> = { create: 0, update: 0, refuse: 0 }
  for (const customer of customers) counts[customer.action] += 1
  return counts
}

/** Database errors can quote the row; a report must not. */
function safeReason(message: string): string {
  return message.includes('@') || /\d{7,}/.test(message)
    ? 'failed to store (details withheld: personal data)'
    : message
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? null : trimmed
}
