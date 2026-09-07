/** What the engine decided to do with one source record. */
export type ProposedAction = 'create' | 'update' | 'withdraw' | 'refuse'

export interface ProposedPrice {
  readonly priceListCode: string
  readonly amountMinor: number
  /** How the source held it, kept so a reader can check the arithmetic. */
  readonly derivedFrom: 'stated' | 'retail_less_reduction'
  readonly reductionMinor?: number
  readonly retailMinor?: number
  /** What we hold now, when this is a change rather than a first price. */
  readonly wasMinor?: number
}

export interface ProposedProduct {
  readonly legacyId: string
  readonly action: ProposedAction
  readonly title: string | null
  /** Why, when the action is `refuse` or `withdraw`. */
  readonly reason?: string
  readonly prices: readonly ProposedPrice[]
  /** Field-level before and after, for the ones a person would want to check. */
  readonly changes?: Readonly<Record<string, { readonly was: unknown; readonly becomes: unknown }>>
  readonly imageCount: number
  readonly languages: readonly string[]
}

export interface ImportProposal {
  readonly source: string
  readonly sourceRecords: number
  readonly products: readonly ProposedProduct[]
  readonly counts: Readonly<Record<ProposedAction, number>>
  /**
   * Retail prices as they stood when the proposal was made.
   *
   * A wholesale price held as "retail less X" is only meaningful against the
   * retail price it was reduced from; if retail moves between proposing and
   * applying, the arithmetic is stale and the proposal has to be redone.
   */
  readonly retailSnapshot: Readonly<Record<string, number | null>>
}

/** One price the new system would quote differently from the old one. */
export interface PriceDifference {
  readonly legacyId: string
  readonly priceListCode: string
  readonly sourceMinor: number
  readonly importedMinor: number
  readonly differenceMinor: number
}

export interface ImportGaps {
  readonly withoutWholesalePrice: readonly string[]
  readonly withoutRetailPrice: readonly string[]
  readonly wholesaleAtOrBelowPurchase: readonly string[]
  readonly wholesaleAtOrAboveRetail: readonly string[]
  readonly withoutPurchasePrice: readonly string[]
  readonly withoutImages: readonly string[]
  readonly withoutTitleInPublishedLanguage: readonly string[]
}

export interface ImportReport {
  readonly source: string
  readonly sourceRecords: number
  readonly imported: number
  readonly skipped: number
  readonly failed: number
  /** Every failure and skip, with the reason it was given. */
  readonly refusals: readonly { readonly legacyId: string; readonly reason: string }[]
  readonly pricesCompared: number
  readonly differences: readonly PriceDifference[]
  readonly gaps: ImportGaps
  /** Set when the reconciliation did not come out even. */
  readonly needsAttention: string | null
}
