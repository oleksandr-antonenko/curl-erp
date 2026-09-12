/*
 * Turning what the paper says into what we hold on the shelf.
 *
 * This proposes and never decides. The reason is in the real documents: an
 * invoice line reading "Дозатор алюмінієвий 24/410, 1 450 шт" is two different
 * things in stock - 750 for one bottle size and 700 for another - and the
 * paper has no column that says so. "Диск-топ 24/410" is keyed by neck size
 * with no volume printed at all. A matcher confident enough to choose here
 * would be wrong in a way nobody ever checks, so an unmatched line stops the
 * posting instead.
 */

export interface MatchCandidate {
  readonly variantId: string
  readonly sku: string
  readonly label: string
  /** Why this was proposed, for a person deciding between two of them. */
  readonly reason: 'sku' | 'exact-name' | 'name-tokens'
  /** 0..1, for ordering only. Never a threshold that auto-accepts. */
  readonly score: number
}

export interface MatchableVariant {
  readonly variantId: string
  readonly sku: string
  /** What a person would call it: product name plus the variant's own title. */
  readonly label: string
}

/**
 * Words as a person reads them, not as a regex splits them.
 *
 * Hyphens and apostrophes are stitched rather than split, because "Диск-топ"
 * and "дисктоп" are the same word to everyone except a tokeniser, and
 * "2-в-1" becomes "2в1". A SKU survives whole: MK-LVN-200 is one token, so it
 * cannot half-match MK-LVN-400.
 */
export function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/['’ʼ`]/g, '')
    .replace(/(\p{L})-(\p{L})/gu, '$1$2')
    .replace(/(\d)-(\p{L})/gu, '$1$2')
    .replace(/(\p{L})-(\d)/gu, '$1$2')
    .split(/[^\p{L}\p{N}-]+/u)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word.length > 1)
}

/**
 * The volume printed in a line, in millilitres.
 *
 * `\b` is useless here: after a Cyrillic letter both sides are non-word to
 * JavaScript, so /(\d+)\s*мл\b/ never matches "100 мл" at all. The lookahead
 * for a non-letter is what actually works, and this cost a whole round of
 * "why is every volume null" in a sibling project.
 */
export function volumeOf(text: string): number | null {
  const match = /(\d{2,4})\s*(мл|ml)(?!\p{L})/iu.exec(text)
  return match?.[1] === undefined ? null : Number(match[1])
}

/** A SKU written out in the line text, which settles the question by itself. */
export function skuIn(text: string, skus: readonly string[]): string | null {
  const haystack = text.toLowerCase().replace(/\s+/g, '')
  for (const sku of skus) {
    if (haystack.includes(sku.toLowerCase().replace(/\s+/g, ''))) return sku
  }
  return null
}

/**
 * Candidates for one printed line, best first.
 *
 * Returns every plausible option rather than the best one. Where two options
 * tie, that tie is the answer: it means the paper does not contain enough to
 * tell them apart, and a person has to look.
 */
export function proposeMatches(
  rawName: string,
  variants: readonly MatchableVariant[],
  limit = 5,
): readonly MatchCandidate[] {
  const exactSku = skuIn(
    rawName,
    variants.map((variant) => variant.sku),
  )
  if (exactSku !== null) {
    const found = variants.find((variant) => variant.sku === exactSku)
    if (found !== undefined) {
      return [{ variantId: found.variantId, sku: found.sku, label: found.label, reason: 'sku', score: 1 }]
    }
  }

  const lineTokens = new Set(tokenize(rawName))
  const lineVolume = volumeOf(rawName)

  const scored = variants.map((variant) => {
    const labelTokens = tokenize(`${variant.label} ${variant.sku}`)
    const shared = labelTokens.filter((token) => lineTokens.has(token)).length
    const coverage = labelTokens.length === 0 ? 0 : shared / labelTokens.length

    const variantVolume = volumeOf(variant.label)
    // A volume that disagrees is disqualifying, not merely unhelpful: 200 ml
    // and 400 ml of the same product share every other word.
    const volumeAgrees = lineVolume === null || variantVolume === null ? null : lineVolume === variantVolume

    const exactName = tokenize(variant.label).join(' ') === tokenize(rawName).join(' ')
    const score = exactName ? 0.99 : coverage * (volumeAgrees === true ? 1 : 0.5)

    return {
      variantId: variant.variantId,
      sku: variant.sku,
      label: variant.label,
      reason: exactName ? ('exact-name' as const) : ('name-tokens' as const),
      score,
      volumeAgrees,
      shared,
    }
  })

  return scored
    .filter((candidate) => candidate.volumeAgrees !== false && candidate.shared > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ variantId, sku, label, reason, score }) => ({ variantId, sku, label, reason, score }))
}
