import { describe, expect, it } from 'vitest'
import { suggestEntity } from './legal-entities.js'

describe('suggesting a legal entity for an order', () => {
  const defaults = new Map([['card_link', 'entity-a']])

  it('takes the configured default for the payment method', () => {
    expect(
      suggestEntity({ paymentMethod: 'card_link', defaults, activeEntityIds: ['entity-a', 'entity-b'] }),
    ).toBe('entity-a')
  })

  it('falls back to the only active entity', () => {
    expect(suggestEntity({ paymentMethod: 'bank_transfer', defaults, activeEntityIds: ['entity-b'] })).toBe(
      'entity-b',
    )
  })

  it('suggests nobody when there is a choice to make and no default', () => {
    expect(
      suggestEntity({ paymentMethod: 'bank_transfer', defaults, activeEntityIds: ['entity-a', 'entity-b'] }),
    ).toBeNull()
  })

  it('suggests nobody for an order without a payment method among several entities', () => {
    expect(
      suggestEntity({ paymentMethod: null, defaults, activeEntityIds: ['entity-a', 'entity-b'] }),
    ).toBeNull()
  })

  it('ignores a default that points at a deactivated entity', () => {
    expect(
      suggestEntity({ paymentMethod: 'card_link', defaults, activeEntityIds: ['entity-b', 'entity-c'] }),
    ).toBeNull()
  })
})
