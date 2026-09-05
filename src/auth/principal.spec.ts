import { describe, expect, it } from 'vitest'
import { isPermission, isSystemRole, PERMISSIONS, SYSTEM_ROLES } from './permissions.js'
import {
  AuthorizationError,
  actorOf,
  authorize,
  can,
  canAll,
  type Principal,
  redact,
  redactMany,
} from './principal.js'

const principal = (permissions: string[], kind: Principal['kind'] = 'staff'): Principal => ({
  kind,
  id: 'p1',
  displayName: 'Test',
  roles: [],
  permissions: new Set(permissions as never[]),
})

describe('permission catalogue', () => {
  it('has no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length)
  })

  it('grants the owner everything', () => {
    expect([...SYSTEM_ROLES.owner].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('keeps costs and the books away from the warehouse role', () => {
    const warehouse = new Set<string>(SYSTEM_ROLES.warehouse)
    expect(warehouse.has('cost.read')).toBe(false)
    expect(warehouse.has('ledger.post')).toBe(false)
    expect(warehouse.has('inventory.write')).toBe(true)
  })

  it('lets the accountant read costs and post to the books', () => {
    const accountant = new Set<string>(SYSTEM_ROLES.accountant)
    expect(accountant.has('cost.read')).toBe(true)
    expect(accountant.has('ledger.post')).toBe(true)
    expect(accountant.has('inventory.write')).toBe(false)
  })

  it('gives the viewer nothing that writes', () => {
    for (const permission of SYSTEM_ROLES.viewer) {
      expect(permission.endsWith('.read')).toBe(true)
    }
  })

  it('recognises known permissions and roles', () => {
    expect(isPermission('ledger.post')).toBe(true)
    expect(isPermission('ledger.destroy')).toBe(false)
    expect(isSystemRole('manager')).toBe(true)
    expect(isSystemRole('sorcerer')).toBe(false)
  })
})

describe('authorisation', () => {
  it('permits what was granted', () => {
    const actor = principal(['catalog.read'])
    expect(can(actor, 'catalog.read')).toBe(true)
    expect(() => authorize(actor, 'catalog.read')).not.toThrow()
  })

  it('refuses what was not', () => {
    const actor = principal(['catalog.read'])
    expect(can(actor, 'ledger.post')).toBe(false)
    expect(() => authorize(actor, 'ledger.post')).toThrow(AuthorizationError)
  })

  it('names the missing permission in the error', () => {
    try {
      authorize(principal([]), 'ledger.post')
      expect.unreachable()
    } catch (error) {
      expect((error as AuthorizationError).permission).toBe('ledger.post')
    }
  })

  it('checks a whole set at once', () => {
    const actor = principal(['catalog.read', 'catalog.write'])
    expect(canAll(actor, ['catalog.read', 'catalog.write'])).toBe(true)
    expect(canAll(actor, ['catalog.read', 'ledger.post'])).toBe(false)
  })
})

describe('actor recorded on documents', () => {
  it.each([
    ['staff', 'human'],
    ['service', 'integration'],
    ['bot', 'bot'],
  ] as const)('maps a %s principal to actor type %s', (kind, expected) => {
    expect(actorOf(principal([], kind)).type).toBe(expected)
  })

  it('carries the conversation for a bot', () => {
    const bot: Principal = { ...principal([], 'bot'), conversationId: 'c-42' }
    expect(actorOf(bot).conversationId).toBe('c-42')
  })
})

describe('field gating', () => {
  const product = { id: 'p1', title: 'Shampoo', retailPrice: 499, purchaseCost: 310, margin: 189 }
  const gated = { purchaseCost: 'cost.read', margin: 'cost.read' } as const

  it('omits gated fields rather than blanking them', () => {
    const visible = redact(principal(['catalog.read']), product, gated)
    expect(visible).toEqual({ id: 'p1', title: 'Shampoo', retailPrice: 499 })
    expect('purchaseCost' in visible).toBe(false)
    expect('margin' in visible).toBe(false)
  })

  it('shows them to someone permitted', () => {
    const visible = redact(principal(['catalog.read', 'cost.read']), product, gated)
    expect(visible.purchaseCost).toBe(310)
    expect(visible.margin).toBe(189)
  })

  it('applies to lists too', () => {
    const rows = redactMany(principal([]), [product, product], gated)
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain('310')
  })
})
