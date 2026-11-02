import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ProposalNotApplicableError } from '../catalog-import/errors.js'
import { contractorAddresses, contractors } from '../contractors/schema.js'
import type { Database } from '../db/client.js'
import { runInTenantScope } from '../tenancy/context.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import type { LegacyCustomer } from './contract.js'
import { FakeCustomerSource } from './fake-source.js'
import { CustomerImport } from './import.js'

const customer = (legacyId: string, overrides: Partial<LegacyCustomer> = {}): LegacyCustomer => ({
  legacyId,
  email: `c${legacyId}@example.com`,
  phone: `+38 (067) 000-00-${legacyId.padStart(2, '0')}`,
  firstName: 'Ім’я',
  lastName: `Прізвище${legacyId}`,
  groups: ['3'],
  deleted: false,
  guest: false,
  ...overrides,
})

describe('customer import', () => {
  let fixture: TenantFixture
  let db: Database
  let scoped: <T>(fn: () => Promise<T>) => Promise<T>

  beforeAll(async () => {
    fixture = await createTenantFixture(['customers'], { migrate: true })
    const tenant = fixture.tenant('customers')
    db = fixture.registry.connectTo(tenant).db
    scoped = (fn) =>
      runInTenantScope({ tenant, db, actor: { type: 'human', id: 'staff-1', displayName: 'Олександр' } }, fn)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(
      sql`truncate table customer_imports, contractor_legacy_ids, contractor_addresses, contractors, change_events restart identity cascade`,
    )
  })

  async function run(source: FakeCustomerSource, precedence: string[] = ['wholesale']) {
    const engine = new CustomerImport(db, source, { groupPrecedence: precedence })
    const { id, proposal } = await scoped(() => engine.propose())
    const report = await scoped(() => engine.apply(id))
    return { engine, id, proposal, report }
  }

  it('writes nothing until applied, then accounts for every source record', async () => {
    const source = new FakeCustomerSource({
      customers: [
        customer('1'),
        customer('2', { deleted: true }),
        customer('3', { guest: true }),
        customer('4', { groups: ['3', '4'] }),
      ],
    })
    const engine = new CustomerImport(db, source)
    const { id, proposal } = await scoped(() => engine.propose())
    expect(proposal.counts).toEqual({ create: 2, update: 0, refuse: 2 })
    expect(await db.select().from(contractors)).toHaveLength(0)

    const report = await scoped(() => engine.apply(id))
    expect(report).toMatchObject({
      sourceRecords: 4,
      imported: 2,
      merged: 0,
      skipped: 2,
      failed: 0,
      needsAttention: null,
    })
    expect(report.imported + report.merged + report.skipped + report.failed).toBe(report.sourceRecords)
    expect(report.refusals).toEqual([
      { legacyId: '2', reason: 'deleted in source' },
      { legacyId: '3', reason: 'guest checkout, not an account' },
    ])
  })

  it('changes nothing when the same proposal is applied twice', async () => {
    const { engine, id } = await run(new FakeCustomerSource({ customers: [customer('1')] }))
    await expect(scoped(() => engine.apply(id))).rejects.toThrow(ProposalNotApplicableError)
    expect(await db.select().from(contractors)).toHaveLength(1)
  })

  it('updates rather than duplicates on a re-run, matching previous ids', async () => {
    const source = new FakeCustomerSource({ customers: [customer('1')] })
    await run(source)
    source.customers = [customer('1', { lastName: 'Нове' })]
    const second = await run(source)
    expect(second.proposal.customers[0]).toMatchObject({ action: 'update', changedFields: ['name'] })
    const rows = await db.select().from(contractors)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Ім’я Нове')
  })

  it('makes one customer of two accounts sharing an email in any case', async () => {
    const { report } = await run(
      new FakeCustomerSource({
        customers: [
          customer('7', { email: 'Olga@x.ua' }),
          customer('12', { email: 'olga@x.ua' }),
        ],
      }),
    )
    expect(report).toMatchObject({ imported: 1, merged: 1, skipped: 0, failed: 0 })
    expect(report.merges).toEqual([{ into: '7', absorbed: ['12'] }])
    const rows = await db.select().from(contractors)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.email).toBe('olga@x.ua')
    const ids = await db.execute<{ legacy_id: string }>(
      sql`select legacy_id from contractor_legacy_ids order by legacy_id`,
    )
    expect(ids.rows.map((row) => row.legacy_id)).toEqual(['12', '7'])
  })

  it('keeps two people sharing a phone apart, and lists them as possible duplicates', async () => {
    const { report } = await run(
      new FakeCustomerSource({
        customers: [
          customer('1', { phone: '+38 (067) 123-45-67' }),
          customer('2', { phone: '380671234567' }),
        ],
      }),
    )
    expect(report.imported).toBe(2)
    expect(report.possibleDuplicates).toEqual([['1', '2']])
  })

  it('puts a customer in two groups into the one that wins, and says so', async () => {
    const { report } = await run(
      new FakeCustomerSource({ customers: [customer('1', { groups: ['3', '4'] })] }),
      ['wholesale'],
    )
    expect(report.groupChoices).toEqual([{ legacyId: '1', among: [null, 'wholesale'], chose: 'wholesale' }])
    expect((await db.select().from(contractors))[0]?.customerGroup).toBe('wholesale')
  })

  it('reconciles each group against the source', async () => {
    const hairdressers = Array.from({ length: 5 }, (_, index) =>
      customer(String(index + 1), { groups: ['4'] }),
    )
    const { report } = await run(new FakeCustomerSource({ customers: [...hairdressers, customer('9')] }))
    expect(report.groups).toEqual([{ group: 'wholesale', source: 5, imported: 5 }])
  })

  it('reports a customer in a group nobody mapped instead of guessing', async () => {
    const { report } = await run(
      new FakeCustomerSource({ customers: [customer('1', { groups: ['3', '99'] })] }),
    )
    expect(report.unmappedGroups).toEqual([{ legacyId: '1', groups: ['99'] }])
  })

  it('brings addresses with their customer, and reports the ones it cannot place', async () => {
    const { report } = await run(
      new FakeCustomerSource({
        customers: [customer('1'), customer('2', { deleted: true })],
        addresses: [
          {
            legacyId: 'a1',
            customerLegacyId: '1',
            city: 'Київ',
            addressText: 'вул. Хрещатик, 1',
            deleted: false,
          },
          {
            legacyId: 'a2',
            customerLegacyId: '2',
            city: 'Львів',
            addressText: 'пл. Ринок, 2',
            deleted: false,
          },
          { legacyId: 'a3', customerLegacyId: '1', addressText: 'стара', deleted: true },
        ],
      }),
    )
    expect(report.addresses).toEqual({
      imported: 1,
      skipped: [
        { legacyId: 'a2', reason: 'its customer 2 was not imported' },
        { legacyId: 'a3', reason: 'deleted in source' },
      ],
    })
    expect(await db.select().from(contractorAddresses)).toHaveLength(1)
  })

  it('keeps names, emails, phones and addresses out of the proposal and the report', async () => {
    const source = new FakeCustomerSource({
      customers: [
        customer('1', {
          email: 'secret.person@example.com',
          phone: '+38 (050) 765-43-21',
          lastName: 'Таємниця',
        }),
        customer('2', { email: 'secret.person@example.com' }),
        customer('3', { phone: '+38 (050) 765-43-21', email: 'other@example.com' }),
      ],
      addresses: [{ legacyId: 'a1', customerLegacyId: '9', addressText: 'вул. Секретна, 7', deleted: false }],
    })
    const { id } = await run(source)
    const stored = await db.execute<{ proposal: unknown; report: unknown }>(
      sql`select proposal, report from customer_imports where id = ${id}`,
    )
    const text = JSON.stringify(stored.rows)
    for (const secret of ['secret.person', '0507654321', '765-43-21', 'Таємниця', 'Секретна', 'other@']) {
      expect(text).not.toContain(secret)
    }
  })

  it('never stores a credential', async () => {
    await run(new FakeCustomerSource({ customers: [customer('1')] }))
    const columns = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_name in ('contractors', 'contractor_addresses', 'contractor_legacy_ids')
    `)
    expect(
      columns.rows.map((row) => row.column_name).filter((name) => /pass|hash|secret|token/.test(name)),
    ).toEqual([])
  })
})
