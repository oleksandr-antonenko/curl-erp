import { describe, expect, it } from 'vitest'
import { distributeByQuantity, reconcile, TotalMismatchError, unitCost } from './money.js'

describe('distributeByQuantity', () => {
  it('loses nothing on an amount that does not divide evenly', () => {
    // The real delivery: 28 100,00 over four label runs.
    const shares = distributeByQuantity(2_810_000, [100, 100, 250, 250])
    expect(shares.reduce((sum, s) => sum + s, 0)).toBe(2_810_000)
  })

  it('gives the indivisible remainder to the last share', () => {
    // 100 minor units across three equal quantities: 33, 33, 34.
    expect(distributeByQuantity(100, [1, 1, 1])).toEqual([33, 33, 34])
  })

  it('scales by quantity rather than splitting equally', () => {
    expect(distributeByQuantity(2_100_000, [100, 500, 150])).toEqual([280_000, 1_400_000, 420_000])
  })

  it('is exact for a single share', () => {
    expect(distributeByQuantity(1_300_000, [800])).toEqual([1_300_000])
  })

  it('refuses a fractional amount, because minor units are whole', () => {
    expect(() => distributeByQuantity(100.5, [2])).toThrow(/integer minor units/)
  })

  it('refuses a quantity that is not a whole count', () => {
    expect(() => distributeByQuantity(100, [0])).toThrow(/whole number/)
    expect(() => distributeByQuantity(100, [1.5])).toThrow(/whole number/)
  })

  it('refuses to distribute across nothing', () => {
    expect(() => distributeByQuantity(100, [])).toThrow(/Nothing to distribute/)
  })
})

describe('reconcile', () => {
  it('accepts parts that sum to the stated total', () => {
    expect(() => reconcile([396_000, 828_000, 495_000, 577_500, 1_386_200], 3_682_700)).not.toThrow()
  })

  it('reports both figures when the parts fall short', () => {
    try {
      reconcile([3_400_000], 6_210_000)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(TotalMismatchError)
      expect((error as TotalMismatchError).linesMinor).toBe(3_400_000)
      expect((error as TotalMismatchError).statedMinor).toBe(6_210_000)
    }
  })

  it('rejects an overshoot as firmly as a shortfall', () => {
    expect(() => reconcile([100, 100], 150)).toThrow(TotalMismatchError)
  })

  it('rejects a single kopeck of drift', () => {
    // What a rounded per-unit figure would produce for 28 100,00 over 700.
    expect(() => reconcile([401_429, 401_429, 1_003_571, 1_003_575], 2_810_000)).toThrow(TotalMismatchError)
  })
})

describe('unitCost', () => {
  it('is a fraction, not a rounded figure to be multiplied back', () => {
    expect(unitCost(2_810_000, 700)).toBeCloseTo(4014.2857, 4)
  })
})
