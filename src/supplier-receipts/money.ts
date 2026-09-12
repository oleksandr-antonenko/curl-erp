/*
 * Arithmetic that has to come out exactly.
 *
 * Every amount here is integer minor units. The reason is a real delivery:
 * 28 100,00 for 700 pieces is 40,142857... each, and a per-unit figure rounded
 * to any number of places and multiplied back does not return 28 100,00. Do
 * that on every delivery and the books drift from the bank by kopecks that
 * nobody can explain and nobody can find.
 *
 * So a group amount is split by quantity and the indivisible remainder is put
 * somewhere explicit, rather than being lost to rounding in several places.
 */

export class ReceiptMathError extends Error {
  override readonly name = 'ReceiptMathError'
}

/** A line's amount disagrees with the total the supplier's document states. */
export class TotalMismatchError extends ReceiptMathError {
  constructor(
    readonly linesMinor: number,
    readonly statedMinor: number,
  ) {
    super(`Lines sum to ${String(linesMinor)} minor units but the document states ${String(statedMinor)}`)
  }
}

/**
 * Splits one amount across quantities, losing nothing.
 *
 * Each share is the amount scaled by its quantity, floored; the remainder that
 * integer division leaves over is handed to the last share. The last one
 * absorbs it rather than the largest, because "the last line carries the
 * rounding" is a rule a person can check by looking, and picking the largest
 * makes the same input produce different output when the order changes.
 */
export function distributeByQuantity(amountMinor: number, quantities: readonly number[]): readonly number[] {
  if (!Number.isInteger(amountMinor)) {
    throw new ReceiptMathError('An amount must be integer minor units')
  }
  if (quantities.length === 0) throw new ReceiptMathError('Nothing to distribute across')
  if (quantities.some((q) => !Number.isInteger(q) || q < 1)) {
    throw new ReceiptMathError('Every quantity must be a whole number of at least one')
  }

  const total = quantities.reduce((sum, q) => sum + q, 0)
  const shares = quantities.map((q) => Math.floor((amountMinor * q) / total))
  const distributed = shares.reduce((sum, s) => sum + s, 0)

  // The remainder is at most quantities.length - 1 minor units, by construction.
  const last = shares.length - 1
  const lastShare = shares[last]
  if (lastShare === undefined) throw new ReceiptMathError('Nothing to distribute across')
  shares[last] = lastShare + (amountMinor - distributed)

  return shares
}

/** Throws unless the parts add up to the whole, exactly. */
export function reconcile(partsMinor: readonly number[], statedMinor: number): void {
  const sum = partsMinor.reduce((total, part) => total + part, 0)
  if (sum !== statedMinor) throw new TotalMismatchError(sum, statedMinor)
}

/**
 * The per-unit cost of a lot, for display only.
 *
 * Never store this and never multiply it back: the amount is the record. It is
 * returned as a fraction so the caller can format it without having already
 * decided how much precision to lose.
 */
export function unitCost(amountMinor: number, quantity: number): number {
  if (quantity < 1) throw new ReceiptMathError('A quantity must be at least one')
  return amountMinor / quantity
}
