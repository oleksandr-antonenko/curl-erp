import { describe, expect, it } from 'vitest'
import { StaticControlPlane } from './control-plane.js'
import { TenantResolver } from './resolver.js'

const multi = new StaticControlPlane([
  { id: 'alpha', name: 'Alpha', databaseUrl: 'postgres://x/alpha', hosts: ['alpha.example.com'] },
  { id: 'beta', name: 'Beta', databaseUrl: 'postgres://x/beta', hosts: ['beta.example.com'] },
  {
    id: 'gamma',
    name: 'Gamma',
    databaseUrl: 'postgres://x/gamma',
    hosts: ['gamma.example.com'],
    status: 'suspended',
  },
])

const single = new StaticControlPlane([{ id: 'only', name: 'Only', databaseUrl: 'postgres://x/only' }])

describe('tenant resolution', () => {
  it('resolves by host', async () => {
    const resolver = new TenantResolver(multi)
    expect((await resolver.resolve({ host: 'alpha.example.com' }))?.tenant.id).toBe('alpha')
    expect((await resolver.resolve({ host: 'BETA.example.com:8080' }))?.tenant.id).toBe('beta')
  })

  it('answers the same for an unknown host and a suspended tenant', async () => {
    const resolver = new TenantResolver(multi)
    expect(await resolver.resolve({ host: 'nobody.example.com' })).toBeNull()
    expect(await resolver.resolve({ host: 'gamma.example.com' })).toBeNull()
  })

  it('honours an explicit tenant only for an authenticated caller', async () => {
    const resolver = new TenantResolver(multi)
    expect(await resolver.resolve({ requestedTenantId: 'alpha' })).toBeNull()
    expect(
      (await resolver.resolve({ requestedTenantId: 'alpha', hasVerifiedCredentials: true }))?.tenant.id,
    ).toBe('alpha')
  })

  it('does not reveal a suspended tenant to an authenticated caller either', async () => {
    const resolver = new TenantResolver(multi)
    expect(await resolver.resolve({ requestedTenantId: 'gamma', hasVerifiedCredentials: true })).toBeNull()
  })

  it('binds a single-tenant installation without any identifier', async () => {
    const resolver = new TenantResolver(single)
    expect((await resolver.resolve({}))?.tenant.id).toBe('only')
    expect((await resolver.resolve({ host: 'anything.example.com' }))?.tenant.id).toBe('only')
  })

  it('never falls back to a sole tenant when one was explicitly named', async () => {
    const resolver = new TenantResolver(single)
    expect(await resolver.resolve({ requestedTenantId: 'other' })).toBeNull()
  })

  it('refuses to guess when several tenants are registered', async () => {
    const resolver = new TenantResolver(multi)
    expect(await resolver.resolve({})).toBeNull()
  })

  it('does not re-point traffic when the sole tenant is suspended', async () => {
    const suspended = new StaticControlPlane([
      { id: 'only', name: 'Only', databaseUrl: 'postgres://x/only', status: 'suspended' },
    ])
    expect(await new TenantResolver(suspended).resolve({})).toBeNull()
  })

  it('applies only the configured rules', async () => {
    const hostOnly = new TenantResolver(single, { rules: ['host'] })
    expect(await hostOnly.resolve({})).toBeNull()
    expect((await hostOnly.resolve({ host: 'alpha.example.com' }))?.tenant.id).toBeUndefined()
  })
})
