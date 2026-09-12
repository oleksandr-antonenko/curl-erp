import { describe, expect, it } from 'vitest'
import { type MatchableVariant, proposeMatches, skuIn, tokenize, volumeOf } from './matching.js'

/* Named as the books of a real business name them, not as a fixture would. */
const VARIANTS: readonly MatchableVariant[] = [
  { variantId: 'v-b100', sku: 'TARA-FL-100', label: 'Флакон 100 мл' },
  { variantId: 'v-b200', sku: 'TARA-FL-200', label: 'Флакон 200 мл' },
  { variantId: 'v-b400', sku: 'TARA-FL-400', label: 'Флакон 400 мл' },
  { variantId: 'v-d100', sku: 'TARA-DT-100', label: 'Дисктоп 100 мл' },
  { variantId: 'v-p200', sku: 'TARA-DZ-200', label: 'Дозатор 200 мл' },
  { variantId: 'v-p400', sku: 'TARA-DZ-400', label: 'Дозатор 400 мл' },
  { variantId: 'v-lshm4', sku: 'MK-SHM-400', label: 'Етикетка MK-SHM-400' },
  { variantId: 'v-lshg4', sku: 'MK-SHG-400', label: 'Етикетка MK-SHG-400' },
]

describe('volumeOf', () => {
  it('reads a volume that is followed by a Cyrillic unit', () => {
    // The trap: \b after "мл" never matches, so a word-boundary pattern reads null.
    expect(volumeOf('Флакон пластиковий Олівія 100 мл (Чорний)')).toBe(100)
  })

  it('reads a volume with no space before the unit', () => {
    expect(volumeOf('Флакон Олівія 200мл')).toBe(200)
  })

  it('is null when the paper prints no volume', () => {
    expect(volumeOf('Дозатор алюмінієвий 24/410 (Золото)')).toBeNull()
  })
})

describe('tokenize', () => {
  it('stitches a hyphenated word rather than splitting it', () => {
    expect(tokenize('Диск-топ алюмінієвий')).toContain('дисктоп')
  })

  it('makes a sku one token, so it cannot half-match its neighbour', () => {
    // Stitched like any other hyphenated word - what matters is that the whole
    // code is one token, so MK-SHM-400 and MK-SHG-400 never share it.
    expect(tokenize('Етикетка MK-SHM-400')).toContain('mkshm400')
    expect(tokenize('Етикетка MK-SHM-400')).not.toContain('mkshg400')
    expect(tokenize('Етикетка MK-SHM-400')).not.toContain('400')
  })

  it('drops apostrophes as a reader does', () => {
    expect(tokenize("об'єму")).toContain('обєму')
  })
})

describe('skuIn', () => {
  it('finds a sku printed in the line', () => {
    expect(skuIn('Етикетка MK-SHM-400, 100 шт', ['MK-SHM-400', 'MK-SHG-400'])).toBe('MK-SHM-400')
  })
})

describe('proposeMatches', () => {
  it('settles the line when a sku is printed on it', () => {
    const [first, ...rest] = proposeMatches('Етикетка MK-SHM-400', VARIANTS)
    expect(first?.variantId).toBe('v-lshm4')
    expect(first?.reason).toBe('sku')
    // One printed sku is an answer, not a shortlist.
    expect(rest).toHaveLength(0)
  })

  it('does not confuse two skus that differ by one letter', () => {
    const [first] = proposeMatches('Етикетка MK-SHG-400', VARIANTS)
    expect(first?.variantId).toBe('v-lshg4')
  })

  it('matches a bottle on its volume', () => {
    const [first] = proposeMatches('Флакон пластиковий Олівія 200 мл (Чорний)', VARIANTS)
    expect(first?.variantId).toBe('v-b200')
  })

  it('never proposes a variant whose volume disagrees', () => {
    const proposed = proposeMatches('Флакон пластиковий Олівія 200 мл', VARIANTS)
    expect(proposed.map((candidate) => candidate.variantId)).not.toContain('v-b400')
  })

  it('reads a hyphenated name the books spell without the hyphen', () => {
    const [first] = proposeMatches('Диск-топ алюмінієвий 24/410 (Золото/Чорний)', VARIANTS)
    expect(first?.variantId).toBe('v-d100')
  })

  it('leaves a line the paper cannot resolve to a tie, not a guess', () => {
    // "Дозатор алюмінієвий 24/410" prints no volume, and 750 of them are for
    // one bottle and 700 for another. Both dozators must come back.
    const proposed = proposeMatches('Дозатор алюмінієвий 24/410 (Золото)', VARIANTS)
    const ids = proposed.map((candidate) => candidate.variantId)
    expect(ids).toContain('v-p200')
    expect(ids).toContain('v-p400')
    expect(proposed[0]?.score).toBe(proposed[1]?.score)
  })

  it('proposes nothing for a line that shares no word', () => {
    expect(proposeMatches('Транспортні послуги', VARIANTS)).toHaveLength(0)
  })
})
