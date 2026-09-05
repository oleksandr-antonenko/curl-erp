import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { runInTenantScope } from './context.js'
import { migrateTenant } from './migrations.js'
import { SecretsCipher, TenantSecretsStore } from './secrets.js'

describe('tenant secrets store', () => {
  let fixture: TenantFixture
  const cipher = SecretsCipher.fromBase64Key(randomBytes(32).toString('base64'))

  beforeAll(async () => {
    fixture = await createTenantFixture(['alpha', 'beta'])
    for (const id of ['alpha', 'beta']) {
      await migrateTenant(fixture.registry.connectTo(fixture.tenant(id)).db)
    }
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  const storeFor = (id: string): TenantSecretsStore =>
    new TenantSecretsStore(fixture.registry.connectTo(fixture.tenant(id)).db, cipher)

  it('stores a credential and hands it back to the integration that owns it', async () => {
    const store = storeFor('alpha')
    await store.set('bank.token', 'uXjKq2-live-98f7a6b5c4d3', 'staff-1')
    expect(await store.reveal('bank.token')).toBe('uXjKq2-live-98f7a6b5c4d3')
  })

  it('shows a masked value to anyone reading settings', async () => {
    const store = storeFor('alpha')
    await store.set('carrier.key', 'abcdef0123456789')

    const described = await store.describe('carrier.key')
    expect(described?.hint).toBe('••••6789')
    expect(JSON.stringify(described)).not.toContain('abcdef0123456789')

    const listed = await store.list()
    expect(JSON.stringify(listed)).not.toContain('abcdef0123456789')
    expect(listed.map((entry) => entry.name)).toContain('carrier.key')
  })

  it('never writes the plain value into the row', async () => {
    const store = storeFor('alpha')
    await store.set('fiscal.password', 'PlainTextPassword1')

    const connection = fixture.registry.connectTo(fixture.tenant('alpha'))
    const rows = await connection.db.query.tenantSecrets.findMany()
    expect(JSON.stringify(rows)).not.toContain('PlainTextPassword1')
  })

  it('keeps one tenant out of another tenant’s credentials', async () => {
    await storeFor('alpha').set('bank.token', 'alpha-token-000111222')
    await storeFor('beta').set('bank.token', 'beta-token-333444555')

    expect(await storeFor('alpha').reveal('bank.token')).toBe('alpha-token-000111222')
    expect(await storeFor('beta').reveal('bank.token')).toBe('beta-token-333444555')

    const betaNames = (await storeFor('beta').list()).map((entry) => entry.name)
    expect(betaNames).toEqual(['bank.token'])
    expect(betaNames).not.toContain('carrier.key')
  })

  it('binds to the tenant in scope', async () => {
    const alpha = fixture.registry.connectTo(fixture.tenant('alpha'))
    const revealed = await runInTenantScope({ tenant: alpha.tenant, db: alpha.db, actor: null }, async () =>
      TenantSecretsStore.forCurrentTenant(cipher).reveal('bank.token'),
    )
    expect(revealed).toBe('alpha-token-000111222')
  })

  it('replaces a rotated credential in place', async () => {
    const store = storeFor('alpha')
    await store.set('bank.token', 'rotated-token-999888777', 'staff-2')

    expect(await store.reveal('bank.token')).toBe('rotated-token-999888777')
    expect((await store.list()).filter((entry) => entry.name === 'bank.token')).toHaveLength(1)
    expect((await store.describe('bank.token'))?.updatedBy).toBe('staff-2')
  })

  it('removes a credential', async () => {
    const store = storeFor('beta')
    expect(await store.delete('bank.token')).toBe(true)
    expect(await store.reveal('bank.token')).toBeNull()
    expect(await store.delete('bank.token')).toBe(false)
  })
})
