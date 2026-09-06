import { and, asc, desc, eq, lte } from 'drizzle-orm'
import { productVariants } from '../catalog/schema.js'
import { recordChange } from '../change-feed/record.js'
import type { Database } from '../db/client.js'
import { tryCurrentScope } from '../tenancy/context.js'
import {
  customerGroups,
  PRICE_ORIGINS,
  type PriceOrigin,
  priceLists,
  pricingRules,
  pricingSettings,
  variantPriceHistory,
  variantPrices,
} from './schema.js'

export class PricingError extends Error {
  override readonly name: string = 'PricingError'
}

/** A guard refused the change. Carries what tripped it, for the report. */
export class PriceRefusedError extends PricingError {
  override readonly name = 'PriceRefusedError'
  constructor(
    readonly reason: PriceRefusalReason,
    readonly detail: Record<string, number | string>,
    message: string,
  ) {
    super(message)
  }
}

export type PriceRefusalReason =
  | 'below_minimum'
  | 'at_or_below_purchase'
  | 'at_or_above_retail'
  | 'jump_too_large'

export interface PriceList {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly currency: string
  readonly isDefault: boolean
}

export interface StoredPrice {
  readonly variantId: string
  readonly priceListId: string
  readonly currency: string
  readonly amountMinor: number
  readonly origin: PriceOrigin
  readonly basisPriceListId: string | null
  readonly factorBasisPoints: number | null
  /** What the basis held when this was computed, so drift is visible. */
  readonly basisAmountMinor: number | null
  readonly updatedAt: Date
  readonly updatedBy: string | null
}

/** How a price was arrived at, in the form a person reads. */
export interface PriceExplanation {
  readonly amountMinor: number
  readonly origin: PriceOrigin
  readonly factorPercent?: number
  readonly basisPriceList?: string
  readonly basisAmountMinor?: number
  /** True when the basis has moved since this amount was computed from it. */
  readonly basisHasChanged?: boolean
}

export interface SetPriceInput {
  readonly variantId: string
  readonly priceListCode: string
  /** Exactly one of these three decides the amount. */
  readonly amountMinor?: number
  readonly percentageOf?: { readonly priceListCode: string; readonly basisPoints: number }
  readonly useRule?: boolean
  readonly currency?: string
  readonly actor?: string
  /** Applies the change even if a guard refuses it, and records why. */
  readonly overrideReason?: string
}

const RETAIL = 'retail'

/**
 * What each customer pays.
 *
 * A price is a number the business decided on. A percentage or a rule is how it
 * was arrived at - kept beside the amount, never in place of it. The shop being
 * replaced holds most of its wholesale prices as "retail less X", so editing a
 * retail price silently moves what a hairdresser pays; here the amount stays put
 * and the interface says that the basis has since moved.
 */
export class Pricing {
  constructor(private readonly db: Database) {}

  // --- lists and groups ----------------------------------------------------

  async createPriceList(input: {
    code: string
    name: string
    currency?: string
    isDefault?: boolean
  }): Promise<PriceList> {
    const [row] = await this.db
      .insert(priceLists)
      .values({
        code: input.code,
        name: input.name,
        currency: input.currency ?? 'UAH',
        isDefault: input.isDefault ?? false,
      })
      .onConflictDoUpdate({
        target: priceLists.code,
        set: { name: input.name, isDefault: input.isDefault ?? false },
      })
      .returning()
    if (row === undefined) throw new PricingError(`Failed to create price list "${input.code}"`)
    return toPriceList(row)
  }

  async listPriceLists(): Promise<PriceList[]> {
    return (await this.db.select().from(priceLists).orderBy(asc(priceLists.code))).map(toPriceList)
  }

  async priceListByCode(code: string): Promise<PriceList> {
    const [row] = await this.db.select().from(priceLists).where(eq(priceLists.code, code)).limit(1)
    if (row === undefined) throw new PricingError(`No price list "${code}"`)
    return toPriceList(row)
  }

  async defaultPriceList(): Promise<PriceList> {
    const [row] = await this.db.select().from(priceLists).where(eq(priceLists.isDefault, true)).limit(1)
    if (row === undefined) throw new PricingError('No default price list is configured')
    return toPriceList(row)
  }

  async defineGroup(input: {
    code: string
    name: string
    priceListCode: string
    isDefault?: boolean
    legacyId?: string
  }): Promise<void> {
    const list = await this.priceListByCode(input.priceListCode)
    const values = {
      code: input.code,
      name: input.name,
      priceListId: list.id,
      isDefault: input.isDefault ?? false,
      legacyId: input.legacyId ?? null,
    }
    await this.db
      .insert(customerGroups)
      .values(values)
      .onConflictDoUpdate({ target: customerGroups.code, set: values })
  }

  /** Groups shown a given price list. */
  async groupsShownPriceList(priceListId: string): Promise<string[]> {
    const rows = await this.db
      .select({ code: customerGroups.code })
      .from(customerGroups)
      .where(eq(customerGroups.priceListId, priceListId))
      .orderBy(asc(customerGroups.code))
    return rows.map((row) => row.code)
  }

  /** The list shown to a group, falling back to the default list. */
  async priceListFor(customerGroup: string | null): Promise<PriceList> {
    if (customerGroup === null) return this.defaultPriceList()
    const [row] = await this.db
      .select({ list: priceLists })
      .from(customerGroups)
      .innerJoin(priceLists, eq(priceLists.id, customerGroups.priceListId))
      .where(eq(customerGroups.code, customerGroup))
      .limit(1)
    return row === undefined ? this.defaultPriceList() : toPriceList(row.list)
  }

  // --- setting a price -----------------------------------------------------

  /**
   * Stores a price, whichever of the three ways decided it.
   *
   * Precedence is deliberate: a stated amount beats a percentage, and a
   * percentage beats a brand rule. The rule is a default for a hundred items,
   * the percentage sets a line, and the stated amount is "we agreed something
   * else for this one" - letting the general overwrite the specific is how a
   * price nobody intended reaches a customer.
   */
  async set(input: SetPriceInput): Promise<StoredPrice> {
    // A guard overridden with an empty reason is a guard bypassed silently,
    // which is exactly what the override is meant to prevent.
    if (input.overrideReason !== undefined && input.overrideReason.trim() === '') {
      throw new PricingError('An override needs a reason: say why this price is right')
    }
    const target = await this.priceListByCode(input.priceListCode)
    const currency = input.currency ?? target.currency
    const resolved = await this.resolveAmount(input, target, currency)

    await this.guard({
      variantId: input.variantId,
      targetList: target,
      currency,
      amountMinor: resolved.amountMinor,
      override: input.overrideReason,
    })

    const actor = input.actor ?? tryCurrentScope()?.actor?.id ?? null

    const values = {
      variantId: input.variantId,
      priceListId: target.id,
      currency,
      amountMinor: resolved.amountMinor,
      origin: resolved.origin,
      basisPriceListId: resolved.basisPriceListId,
      factorBasisPoints: resolved.factorBasisPoints,
      basisAmountMinor: resolved.basisAmountMinor,
      ruleId: resolved.ruleId,
      updatedAt: new Date(),
      updatedBy: actor,
    }

    const stored = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(variantPrices)
        .values(values)
        .onConflictDoUpdate({
          target: [variantPrices.variantId, variantPrices.priceListId, variantPrices.currency],
          set: values,
        })
        .returning()
      if (row === undefined) throw new PricingError('Failed to store price')

      await tx.insert(variantPriceHistory).values({
        variantId: input.variantId,
        priceListId: target.id,
        currency,
        amountMinor: resolved.amountMinor,
        origin: resolved.origin,
        factorBasisPoints: resolved.factorBasisPoints,
        actorType: tryCurrentScope()?.actor?.type ?? null,
        actorId: actor,
        overrideReason: input.overrideReason ?? null,
      })

      await recordChange(tx, {
        entityType: 'price',
        entityId: `${input.variantId}:${target.code}`,
        kind: 'updated',
        changedFields: ['amountMinor'],
      })

      return row
    })

    return toStoredPrice(stored)
  }

  private async resolveAmount(
    input: SetPriceInput,
    target: PriceList,
    currency: string,
  ): Promise<{
    amountMinor: number
    origin: PriceOrigin
    basisPriceListId: string | null
    factorBasisPoints: number | null
    basisAmountMinor: number | null
    ruleId: string | null
  }> {
    // Stated beats percentage beats rule.
    if (input.amountMinor !== undefined) {
      return {
        amountMinor: input.amountMinor,
        origin: 'stated',
        basisPriceListId: null,
        factorBasisPoints: null,
        basisAmountMinor: null,
        ruleId: null,
      }
    }

    if (input.percentageOf !== undefined) {
      const basis = await this.priceListByCode(input.percentageOf.priceListCode)
      const basisAmount = await this.amountOf(input.variantId, basis.id, currency)
      if (basisAmount === null) {
        throw new PricingError(`Cannot compute a percentage: the variant has no price in "${basis.code}"`)
      }
      return {
        amountMinor: applyFactor(basisAmount, input.percentageOf.basisPoints),
        origin: 'percentage',
        basisPriceListId: basis.id,
        factorBasisPoints: input.percentageOf.basisPoints,
        basisAmountMinor: basisAmount,
        ruleId: null,
      }
    }

    if (input.useRule === true) {
      const rule = await this.ruleFor(input.variantId, target.id)
      if (rule === null) {
        throw new PricingError(`No pricing rule applies to this variant for "${target.code}"`)
      }
      const basisAmount =
        rule.basisPriceListId === null
          ? null
          : await this.amountOf(input.variantId, rule.basisPriceListId, currency)
      if (basisAmount === null) {
        throw new PricingError('The rule names a price the variant does not have')
      }
      return {
        amountMinor: applyFactor(basisAmount, rule.factorBasisPoints),
        origin: 'rule',
        basisPriceListId: rule.basisPriceListId,
        factorBasisPoints: rule.factorBasisPoints,
        basisAmountMinor: basisAmount,
        ruleId: rule.id,
      }
    }

    throw new PricingError('A price must be stated, computed from a percentage, or set by a rule')
  }

  // --- guards --------------------------------------------------------------

  /** Adjusts the thresholds the guards work to. */
  async configure(input: {
    minimumAmountMinor?: number
    maximumChangeBasisPoints?: number
    refuseAtOrBelowPurchase?: boolean
    refuseAtOrAboveRetail?: boolean
  }): Promise<typeof pricingSettings.$inferSelect> {
    const current = await this.settings()
    const [row] = await this.db
      .update(pricingSettings)
      .set({
        minimumAmountMinor: input.minimumAmountMinor ?? current.minimumAmountMinor,
        maximumChangeBasisPoints: input.maximumChangeBasisPoints ?? current.maximumChangeBasisPoints,
        refuseAtOrBelowPurchase: input.refuseAtOrBelowPurchase ?? current.refuseAtOrBelowPurchase,
        refuseAtOrAboveRetail: input.refuseAtOrAboveRetail ?? current.refuseAtOrAboveRetail,
        updatedAt: new Date(),
      })
      .where(eq(pricingSettings.id, current.id))
      .returning()
    if (row === undefined) throw new PricingError('Failed to store pricing settings')
    return row
  }

  async settings(): Promise<typeof pricingSettings.$inferSelect> {
    const [row] = await this.db.select().from(pricingSettings).limit(1)
    if (row !== undefined) return row
    const [created] = await this.db.insert(pricingSettings).values({ id: 1 }).returning()
    if (created === undefined) throw new PricingError('Failed to read pricing settings')
    return created
  }

  private async guard(input: {
    variantId: string
    targetList: PriceList
    currency: string
    amountMinor: number
    override?: string | undefined
  }): Promise<void> {
    const settings = await this.settings()
    const refuse = (
      reason: PriceRefusalReason,
      detail: Record<string, number | string>,
      message: string,
    ): void => {
      // An override is a decision someone with permission made and is recorded
      // with the price; without one the change simply does not happen.
      if (input.override !== undefined) return
      throw new PriceRefusedError(reason, detail, message)
    }

    if (settings.minimumAmountMinor > 0 && input.amountMinor < settings.minimumAmountMinor) {
      refuse(
        'below_minimum',
        { amountMinor: input.amountMinor, minimumMinor: settings.minimumAmountMinor },
        `Price ${String(input.amountMinor)} is below the minimum ${String(settings.minimumAmountMinor)}`,
      )
    }

    // The default list is what everyone else is compared against, so comparing
    // it to itself would refuse every retail price for being its own equal.
    if (!input.targetList.isDefault) {
      await this.guardAgainstMarginLoss(input, settings, refuse)
    }

    if (settings.maximumChangeBasisPoints > 0) {
      const current = await this.amountOf(input.variantId, input.targetList.id, input.currency)
      if (current !== null && current > 0) {
        const movedBasisPoints = Math.round((Math.abs(input.amountMinor - current) / current) * 10_000)
        if (movedBasisPoints > settings.maximumChangeBasisPoints) {
          refuse(
            'jump_too_large',
            { from: current, to: input.amountMinor, movedBasisPoints },
            `Price moves from ${String(current)} to ${String(input.amountMinor)}, more than the ` +
              `${String(settings.maximumChangeBasisPoints / 100)}% allowed in one change`,
          )
        }
      }
    }
  }

  /** The two comparisons that only make sense for a list below the default one. */
  private async guardAgainstMarginLoss(
    input: { variantId: string; currency: string; amountMinor: number },
    settings: typeof pricingSettings.$inferSelect,
    refuse: (reason: PriceRefusalReason, detail: Record<string, number | string>, message: string) => void,
  ): Promise<void> {
    if (settings.refuseAtOrBelowPurchase) {
      const [variant] = await this.db
        .select({ purchase: productVariants.plannedPurchasePriceMinor })
        .from(productVariants)
        .where(eq(productVariants.id, input.variantId))
        .limit(1)
      const purchase = variant?.purchase ?? null
      if (purchase !== null && purchase > 0 && input.amountMinor <= purchase) {
        refuse(
          'at_or_below_purchase',
          { amountMinor: input.amountMinor, purchaseMinor: purchase },
          `Price ${String(input.amountMinor)} is at or below the purchase price ${String(purchase)}`,
        )
      }
    }

    if (settings.refuseAtOrAboveRetail) {
      const retail = await this.amountOfByCode(input.variantId, RETAIL, input.currency)
      if (retail !== null && input.amountMinor >= retail) {
        refuse(
          'at_or_above_retail',
          { amountMinor: input.amountMinor, retailMinor: retail },
          `Wholesale price ${String(input.amountMinor)} is at or above retail ${String(retail)}`,
        )
      }
    }
  }

  // --- reading -------------------------------------------------------------

  async amountOf(variantId: string, priceListId: string, currency = 'UAH'): Promise<number | null> {
    const [row] = await this.db
      .select({ amountMinor: variantPrices.amountMinor })
      .from(variantPrices)
      .where(
        and(
          eq(variantPrices.variantId, variantId),
          eq(variantPrices.priceListId, priceListId),
          eq(variantPrices.currency, currency),
        ),
      )
      .limit(1)
    return row?.amountMinor ?? null
  }

  async amountOfByCode(variantId: string, priceListCode: string, currency = 'UAH'): Promise<number | null> {
    const [list] = await this.db
      .select({ id: priceLists.id })
      .from(priceLists)
      .where(eq(priceLists.code, priceListCode))
      .limit(1)
    return list === undefined ? null : this.amountOf(variantId, list.id, currency)
  }

  /**
   * What a customer in this group would be quoted.
   *
   * Falls back to the default list when the group has no price, and says so, so
   * a missing wholesale price is visible rather than silently charged at retail.
   */
  async quote(
    variantId: string,
    customerGroup: string | null,
    currency = 'UAH',
  ): Promise<{ amountMinor: number; priceListCode: string; fellBack: boolean } | null> {
    const list = await this.priceListFor(customerGroup)
    const own = await this.amountOf(variantId, list.id, currency)
    if (own !== null) return { amountMinor: own, priceListCode: list.code, fellBack: false }

    const fallback = await this.defaultPriceList()
    if (fallback.id === list.id) return null

    const amount = await this.amountOf(variantId, fallback.id, currency)
    return amount === null ? null : { amountMinor: amount, priceListCode: fallback.code, fellBack: true }
  }

  /** The amount together with how it was arrived at, for staff screens. */
  async explain(
    variantId: string,
    priceListCode: string,
    currency = 'UAH',
  ): Promise<PriceExplanation | null> {
    const list = await this.priceListByCode(priceListCode)
    const [row] = await this.db
      .select()
      .from(variantPrices)
      .where(
        and(
          eq(variantPrices.variantId, variantId),
          eq(variantPrices.priceListId, list.id),
          eq(variantPrices.currency, currency),
        ),
      )
      .limit(1)
    if (row === undefined) return null

    if (row.origin === 'stated' || row.basisPriceListId === null) {
      return { amountMinor: row.amountMinor, origin: row.origin as PriceOrigin }
    }

    const [basis] = await this.db
      .select({ code: priceLists.code })
      .from(priceLists)
      .where(eq(priceLists.id, row.basisPriceListId))
      .limit(1)
    const basisNow = await this.amountOf(variantId, row.basisPriceListId, currency)

    return {
      amountMinor: row.amountMinor,
      origin: row.origin as PriceOrigin,
      ...(row.factorBasisPoints === null ? {} : { factorPercent: row.factorBasisPoints / 100 }),
      ...(basis === undefined ? {} : { basisPriceList: basis.code }),
      ...(row.basisAmountMinor === null ? {} : { basisAmountMinor: row.basisAmountMinor }),
      basisHasChanged: basisNow !== null && basisNow !== row.basisAmountMinor,
    }
  }

  /** What the price was at a given moment, and who set it. */
  async priceAt(
    variantId: string,
    priceListCode: string,
    moment: Date,
    currency = 'UAH',
  ): Promise<{
    amountMinor: number
    actorId: string | null
    validFrom: Date
    overrideReason: string | null
  } | null> {
    const list = await this.priceListByCode(priceListCode)
    const [row] = await this.db
      .select()
      .from(variantPriceHistory)
      .where(
        and(
          eq(variantPriceHistory.variantId, variantId),
          eq(variantPriceHistory.priceListId, list.id),
          eq(variantPriceHistory.currency, currency),
          lte(variantPriceHistory.validFrom, moment),
        ),
      )
      .orderBy(desc(variantPriceHistory.validFrom))
      .limit(1)
    return row === undefined
      ? null
      : {
          amountMinor: row.amountMinor,
          actorId: row.actorId,
          validFrom: row.validFrom,
          overrideReason: row.overrideReason,
        }
  }

  /**
   * Margin against the planned purchase price.
   *
   * Always labelled expected, never actual: the purchase price is what a
   * supplier's list said, not what we paid. Real cost is what FIFO says when
   * stock has been received, and a margin computed from a plan and presented as
   * fact is how a business believes it is profitable while it is not.
   */
  async expectedMargin(
    variantId: string,
    priceListCode: string,
    currency = 'UAH',
  ): Promise<{
    basis: 'planned_purchase_price'
    expected: true
    priceMinor: number
    purchaseMinor: number
    marginMinor: number
    marginBasisPoints: number
  } | null> {
    const price = await this.amountOfByCode(variantId, priceListCode, currency)
    if (price === null) return null

    const [variant] = await this.db
      .select({ purchase: productVariants.plannedPurchasePriceMinor })
      .from(productVariants)
      .where(eq(productVariants.id, variantId))
      .limit(1)
    const purchase = variant?.purchase ?? null
    if (purchase === null || purchase <= 0) return null

    const marginMinor = price - purchase
    return {
      basis: 'planned_purchase_price',
      expected: true,
      priceMinor: price,
      purchaseMinor: purchase,
      marginMinor,
      marginBasisPoints: Math.round((marginMinor / price) * 10_000),
    }
  }

  // --- rules ---------------------------------------------------------------

  async defineRule(input: {
    scope: 'brand' | 'supplier'
    brandId?: string
    supplierCode?: string
    targetPriceListCode: string
    basisPriceListCode: string
    factorBasisPoints: number
    note?: string
  }): Promise<string> {
    const target = await this.priceListByCode(input.targetPriceListCode)
    const basis = await this.priceListByCode(input.basisPriceListCode)

    const [row] = await this.db
      .insert(pricingRules)
      .values({
        scope: input.scope,
        brandId: input.brandId ?? null,
        supplierCode: input.supplierCode ?? null,
        targetPriceListId: target.id,
        basisPriceListId: basis.id,
        factorBasisPoints: input.factorBasisPoints,
        note: input.note ?? null,
      })
      .returning({ id: pricingRules.id })
    if (row === undefined) throw new PricingError('Failed to define pricing rule')
    return row.id
  }

  private async ruleFor(
    variantId: string,
    targetPriceListId: string,
  ): Promise<typeof pricingRules.$inferSelect | null> {
    const [variant] = await this.db
      .select({ productId: productVariants.productId, supplier: productVariants.supplierReference })
      .from(productVariants)
      .where(eq(productVariants.id, variantId))
      .limit(1)
    if (variant === undefined) return null

    const { products } = await import('../catalog/schema.js')
    const [product] = await this.db
      .select({ brandId: products.brandId })
      .from(products)
      .where(eq(products.id, variant.productId))
      .limit(1)

    if (product?.brandId != null) {
      const [rule] = await this.db
        .select()
        .from(pricingRules)
        .where(
          and(
            eq(pricingRules.brandId, product.brandId),
            eq(pricingRules.targetPriceListId, targetPriceListId),
          ),
        )
        .limit(1)
      if (rule !== undefined) return rule
    }

    return null
  }
}

/** Rounds half away from zero: 70% of 49900 is 34930, never 34929.999. */
export function applyFactor(amountMinor: number, basisPoints: number): number {
  return Math.round((amountMinor * basisPoints) / 10_000)
}

function toPriceList(row: {
  id: string
  code: string
  name: string
  currency: string
  isDefault: boolean
}): PriceList {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    currency: row.currency,
    isDefault: row.isDefault,
  }
}

function toStoredPrice(row: typeof variantPrices.$inferSelect): StoredPrice {
  return {
    variantId: row.variantId,
    priceListId: row.priceListId,
    currency: row.currency,
    amountMinor: row.amountMinor,
    origin: row.origin as PriceOrigin,
    basisPriceListId: row.basisPriceListId,
    factorBasisPoints: row.factorBasisPoints,
    basisAmountMinor: row.basisAmountMinor,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }
}

export { PRICE_ORIGINS }
