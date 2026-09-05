import { describe, expect, it } from 'vitest'
import { runChannelContractTests } from './contract-tests.js'
import { MemoryChannelAdapter } from './memory-adapter.js'

// The reference adapter is held to the same contract as every other one: a
// suite that only its author can pass is not a contract.
runChannelContractTests({
  describe,
  it,
  expect: expect as never,
  createAdapter: () => new MemoryChannelAdapter(),
})

describe('reference adapter behaviour', () => {
  it('refuses a negative availability', async () => {
    const adapter = new MemoryChannelAdapter()
    await adapter.publishProduct({
      localId: 'p',
      title: 'p',
      variants: [{ localId: 'v', sku: 'v', title: 'v', priceMinor: 100, currency: 'UAH' }],
    })
    await expect(adapter.publishStock([{ variantLocalId: 'v', available: -1 }])).rejects.toThrow(
      /negative availability/,
    )
  })

  it('refuses a per-group price when it cannot hold one', async () => {
    const adapter = new MemoryChannelAdapter({ capabilities: { customerGroups: false } })
    await adapter.publishProduct({
      localId: 'p',
      title: 'p',
      variants: [{ localId: 'v', sku: 'v', title: 'v', priceMinor: 100, currency: 'UAH' }],
    })
    await expect(
      adapter.publishPrices([
        { variantLocalId: 'v', priceMinor: 90, currency: 'UAH', customerGroup: 'wholesale' },
      ]),
    ).rejects.toThrow(/customer group/)
  })

  it('fails every call while unreachable, and recovers', async () => {
    const adapter = new MemoryChannelAdapter({ unreachable: true })
    await expect(adapter.publishProduct({ localId: 'p', title: 'p', variants: [] })).rejects.toThrow(
      /unreachable/,
    )

    adapter.setUnreachable(false)
    const result = await adapter.publishProduct({ localId: 'p', title: 'p', variants: [] })
    expect(result.externalId).toContain('memory')
  })
})
