import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { FileControlPlane, TenantAlreadyExistsError, TenantNotFoundError } from './control-plane.js'
import { parseControlPlaneFile, resolveDatabaseUrl, TenantConfigurationError } from './tenant.js'

async function temporaryFile(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'erp-cp-'))
  const path = join(dir, 'control-plane.json')
  if (contents !== undefined) await writeFile(path, contents, 'utf8')
  return path
}

const ONE_TENANT = JSON.stringify({
  version: 1,
  tenants: [
    {
      id: 'curlmakers',
      name: 'CurlMakers',
      databaseUrl: 'postgres://user:pass@localhost:5432/curlmakers',
      status: 'active',
      entitlements: ['channel-storefront'],
    },
  ],
})

describe('control plane document', () => {
  it('accepts a single-tenant registry', () => {
    const document = parseControlPlaneFile(JSON.parse(ONE_TENANT))
    expect(document.tenants).toHaveLength(1)
    expect(document.tenants[0]?.id).toBe('curlmakers')
    expect(document.tenants[0]?.status).toBe('active')
  })

  it('defaults status and entitlements', () => {
    const document = parseControlPlaneFile({
      version: 1,
      tenants: [{ id: 'shop', name: 'Shop', databaseUrl: 'postgres://localhost/shop' }],
    })
    expect(document.tenants[0]?.status).toBe('active')
    expect(document.tenants[0]?.entitlements).toEqual([])
  })

  it.each([
    ['a missing version', { tenants: [] }],
    ['an unknown version', { version: 2, tenants: [] }],
    ['a tenant without a database', { version: 1, tenants: [{ id: 'shop', name: 'Shop' }] }],
    [
      'an identifier that is not slug-shaped',
      { version: 1, tenants: [{ id: 'Shop Ltd', name: 'Shop', databaseUrl: 'postgres://x/y' }] },
    ],
    [
      'an unknown status',
      {
        version: 1,
        tenants: [{ id: 'shop', name: 'Shop', databaseUrl: 'postgres://x/y', status: 'paused' }],
      },
    ],
  ])('rejects %s', (_label, document) => {
    expect(() => parseControlPlaneFile(document)).toThrow(TenantConfigurationError)
  })

  it('rejects duplicate tenant identifiers', () => {
    const tenant = { id: 'shop', name: 'Shop', databaseUrl: 'postgres://x/y' }
    expect(() => parseControlPlaneFile({ version: 1, tenants: [tenant, tenant] })).toThrow(
      /Duplicate tenant id/,
    )
  })
})

describe('database url references', () => {
  it('passes a literal connection string through', () => {
    expect(resolveDatabaseUrl('postgres://localhost/shop', {})).toBe('postgres://localhost/shop')
  })

  it('resolves an environment reference so the file holds no credentials', () => {
    expect(resolveDatabaseUrl('${SHOP_DATABASE_URL}', { SHOP_DATABASE_URL: 'postgres://real' })).toBe(
      'postgres://real',
    )
  })

  it('fails loudly when the referenced variable is missing', () => {
    expect(() => resolveDatabaseUrl('${SHOP_DATABASE_URL}', {})).toThrow(TenantConfigurationError)
  })
})

describe('file control plane', () => {
  let path: string

  beforeEach(async () => {
    path = await temporaryFile(ONE_TENANT)
  })

  it('serves a single-tenant installation with no control plane database', async () => {
    const plane = new FileControlPlane(path)
    expect(plane.kind).toBe('file')
    const tenants = await plane.list()
    expect(tenants).toHaveLength(1)
    expect((await plane.get('curlmakers')).name).toBe('CurlMakers')
  })

  it('treats a missing file as an empty registry', async () => {
    const plane = new FileControlPlane(await temporaryFile())
    expect(await plane.list()).toEqual([])
  })

  it('rejects a malformed file instead of guessing', async () => {
    const plane = new FileControlPlane(await temporaryFile('{ not json'))
    await expect(plane.list()).rejects.toThrow(TenantConfigurationError)
  })

  it('reports an unknown tenant', async () => {
    const plane = new FileControlPlane(path)
    expect(await plane.find('missing')).toBeNull()
    await expect(plane.get('missing')).rejects.toThrow(TenantNotFoundError)
  })

  it('registers, updates and removes tenants', async () => {
    const plane = new FileControlPlane(path)

    await plane.register({
      id: 'second',
      name: 'Second',
      databaseUrl: 'postgres://localhost/second',
      status: 'active',
      entitlements: [],
    })
    expect(await plane.list()).toHaveLength(2)

    const updated = await plane.update('second', { status: 'suspended' })
    expect(updated.status).toBe('suspended')
    expect((await plane.get('second')).status).toBe('suspended')

    await plane.remove('second')
    expect(await plane.find('second')).toBeNull()
  })

  it('refuses to register the same tenant twice', async () => {
    const plane = new FileControlPlane(path)
    await expect(
      plane.register({
        id: 'curlmakers',
        name: 'Duplicate',
        databaseUrl: 'postgres://localhost/other',
        status: 'active',
        entitlements: [],
      }),
    ).rejects.toThrow(TenantAlreadyExistsError)
    expect(await plane.list()).toHaveLength(1)
  })

  it('leaves the file readable after a write', async () => {
    const plane = new FileControlPlane(path)
    await plane.update('curlmakers', { name: 'CurlMakers UA' })
    const written = JSON.parse(await readFile(path, 'utf8')) as unknown
    expect(parseControlPlaneFile(written).tenants[0]?.name).toBe('CurlMakers UA')
  })
})
