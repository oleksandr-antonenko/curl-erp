import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { changeEvents } from '../change-feed/schema.js'
import type { Database } from '../db/client.js'
import { runInTenantScope } from '../tenancy/context.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import {
  DuplicateRegistryCodeError,
  LegalEntities,
  LegalEntityInUseError,
  nextDocumentNumber,
} from './legal-entities.js'

describe('legal entities', () => {
  let fixture: TenantFixture
  let db: Database
  let scoped: <T>(fn: () => Promise<T>) => Promise<T>

  beforeAll(async () => {
    fixture = await createTenantFixture(['entities'], { migrate: true })
    const tenant = fixture.tenant('entities')
    db = fixture.registry.connectTo(tenant).db
    scoped = (fn) => runInTenantScope({ tenant, db, actor: { type: 'human', id: 'staff-1' } }, fn)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.execute(
      sql`truncate table legal_entities, legal_entity_changes, legal_entity_payment_defaults, document_sequences, change_events restart identity cascade`,
    )
  })

  it('holds two entities in one tenant', async () => {
    const entities = new LegalEntities(db)
    await scoped(() => entities.register({ name: 'ФОП Перша', registryCode: '1111111111' }))
    await scoped(() => entities.register({ name: 'ФОП Друга', registryCode: '2222222222' }))
    expect((await entities.list()).map((entity) => entity.name)).toEqual(['ФОП Друга', 'ФОП Перша'])
  })

  it('refuses a registry code already used in the tenant, naming its holder', async () => {
    const entities = new LegalEntities(db)
    await scoped(() => entities.register({ name: 'ФОП Перша', registryCode: '1111111111' }))
    const second = scoped(() => entities.register({ name: 'Хтось', registryCode: '1111111111' }))
    await expect(second).rejects.toThrow(DuplicateRegistryCodeError)
    await expect(
      scoped(() => entities.register({ name: 'Хтось', registryCode: '1111111111' })),
    ).rejects.toThrow(/ФОП Перша/)
  })

  it('journals the old and new IBAN, and the feed names only the field', async () => {
    const entities = new LegalEntities(db)
    const entity = await scoped(() =>
      entities.register({
        name: 'ФОП Перша',
        registryCode: '1111111111',
        iban: 'UA21 3223 1300 0002 6007 2335 6600 1',
      }),
    )
    expect(entity.iban).toBe('UA213223130000026007233566001')

    await scoped(() => entities.update(entity.id, { iban: 'UA90 3052 9900 0002 6006 0000 0000 0' }))

    const [change] = await entities.changes(entity.id)
    expect(change).toMatchObject({
      field: 'iban',
      oldValue: 'UA213223130000026007233566001',
      newValue: 'UA903052990000026006000000000',
      actorType: 'human',
      actorId: 'staff-1',
    })

    const events = await db.select().from(changeEvents).where(sql`${changeEvents.kind} = 'updated'`)
    expect(events).toHaveLength(1)
    expect(events[0]?.changedFields).toEqual(['iban'])
    expect(JSON.stringify(events[0])).not.toContain('UA90')
  })

  it('refuses to delete an entity that history references, and deactivates it instead', async () => {
    const entities = new LegalEntities(db, [{ heldBy: async () => 'sales order 1' }])
    const entity = await scoped(() => entities.register({ name: 'ФОП Перша', registryCode: '1111111111' }))

    await expect(scoped(() => entities.remove(entity.id))).rejects.toThrow(LegalEntityInUseError)

    await scoped(() => entities.deactivate(entity.id))
    expect(await entities.list()).toHaveLength(0)
    expect((await entities.find(entity.id))?.isActive).toBe(false)

    await scoped(() => entities.reactivate(entity.id))
    expect((await entities.list()).map((found) => found.id)).toEqual([entity.id])
    expect((await entities.changes(entity.id)).map((change) => change.newValue)).toEqual(['true', 'false'])
  })

  it('suggests the default for a method, and nothing for a deactivated default', async () => {
    const entities = new LegalEntities(db)
    const first = await scoped(() => entities.register({ name: 'ФОП Перша', registryCode: '1111111111' }))
    const second = await scoped(() => entities.register({ name: 'ФОП Друга', registryCode: '2222222222' }))
    await scoped(() => entities.setPaymentDefault('card_link', first.id))

    expect(await entities.suggestFor('card_link')).toBe(first.id)
    expect(await entities.suggestFor('bank_transfer')).toBeNull()

    await scoped(() => entities.deactivate(first.id))
    // With the default gone and one entity left, the one left is the answer.
    expect(await entities.suggestFor('card_link')).toBe(second.id)
  })

  it('issues 20 distinct consecutive numbers to 20 parallel confirmations', async () => {
    const entities = new LegalEntities(db)
    const entity = await scoped(() => entities.register({ name: 'ФОП Перша', registryCode: '1111111111' }))

    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.transaction((tx) => nextDocumentNumber(tx, entity.id, 'sales_order')),
      ),
    )
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
  })

  it('does not spend a number in a transaction that rolls back', async () => {
    const entities = new LegalEntities(db)
    const entity = await scoped(() => entities.register({ name: 'ФОП Перша', registryCode: '1111111111' }))

    await expect(
      db.transaction(async (tx) => {
        await nextDocumentNumber(tx, entity.id, 'sales_order')
        throw new Error('confirmation failed')
      }),
    ).rejects.toThrow('confirmation failed')

    expect(await db.transaction((tx) => nextDocumentNumber(tx, entity.id, 'sales_order'))).toBe(1)
  })

  it('keeps separate sequences per entity', async () => {
    const entities = new LegalEntities(db)
    const first = await scoped(() => entities.register({ name: 'ФОП Перша', registryCode: '1111111111' }))
    const second = await scoped(() => entities.register({ name: 'ФОП Друга', registryCode: '2222222222' }))
    expect(await nextDocumentNumber(db, first.id, 'sales_order')).toBe(1)
    expect(await nextDocumentNumber(db, second.id, 'sales_order')).toBe(1)
    expect(await nextDocumentNumber(db, first.id, 'sales_order')).toBe(2)
  })
})
