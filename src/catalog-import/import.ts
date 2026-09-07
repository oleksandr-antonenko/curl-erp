import { desc, eq } from 'drizzle-orm'
import { Images } from '../catalog/images.js'
import { Catalog, type ProductInput, type ProductTextInput } from '../catalog/products.js'
import { Taxonomy } from '../catalog/taxonomy.js'
import type { Database } from '../db/client.js'
import { Pricing } from '../pricing/pricing.js'
import { tryCurrentScope } from '../tenancy/context.js'
import type { LegacyCatalogReader, LegacyPrice, LegacyProduct, LegacyText } from './contract.js'
import { ImportError, ProposalNotApplicableError } from './errors.js'
import { catalogImports } from './schema.js'
import type {
  ImportGaps,
  ImportProposal,
  ImportReport,
  PriceDifference,
  ProposedAction,
  ProposedPrice,
  ProposedProduct,
} from './types.js'

export interface CatalogImportOptions {
  /** Price list the source's retail price lands in. */
  readonly retailPriceListCode?: string
  /**
   * Withdraw published products the source no longer offers.
   *
   * Legitimate when the range changes, catastrophic against a truncated
   * export - so it is off unless asked for, and the proposal says how many
   * would go before anyone applies it.
   */
  readonly withdrawMissing?: boolean
  /** Origin recorded against imported images. */
  readonly imageOrigin?: 'imported'
}

/**
 * Moves a catalog off a previous system.
 *
 * Two halves, and the order matters: a proposal that changes nothing, and an
 * apply that does exactly what the proposal said. An import that writes as it
 * reads is one nobody can review, and this one moves the prices ninety-five per
 * cent of the revenue is quoted from.
 */
export class CatalogImport {
  private readonly catalog: Catalog
  private readonly pricing: Pricing
  private readonly taxonomy: Taxonomy
  private readonly images: Images
  private readonly retailList: string
  private readonly brandsByName = new Map<string, string>()

  constructor(
    private readonly db: Database,
    private readonly reader: LegacyCatalogReader,
    private readonly options: CatalogImportOptions = {},
  ) {
    this.catalog = new Catalog(db)
    this.pricing = new Pricing(db)
    this.taxonomy = new Taxonomy(db)
    this.images = new Images(db)
    this.retailList = options.retailPriceListCode ?? 'retail'
  }

  // --- proposing -----------------------------------------------------------

  /** Works out what would change. Writes the proposal and nothing else. */
  async propose(): Promise<{ id: string; proposal: ImportProposal }> {
    const source = await this.reader.readProducts()
    const groups = await this.reader.groupMapping()

    const products: ProposedProduct[] = []
    const retailSnapshot: Record<string, number | null> = {}

    for (const record of source) {
      products.push(await this.proposeOne(record, groups))
      retailSnapshot[record.legacyId] = record.retailMinor
    }

    const counts = tally(products)
    const proposal: ImportProposal = {
      source: this.reader.sourceName,
      sourceRecords: source.length,
      products,
      counts,
      retailSnapshot,
    }

    const [row] = await this.db
      .insert(catalogImports)
      .values({
        source: this.reader.sourceName,
        state: 'proposed',
        proposedBy: tryCurrentScope()?.actor?.id ?? null,
        proposedByName: tryCurrentScope()?.actor?.displayName ?? null,
        sourceRecords: source.length,
        proposal,
      })
      .returning({ id: catalogImports.id })
    if (row === undefined) throw new ImportError('Failed to store the proposal')

    return { id: row.id, proposal }
  }

  private async proposeOne(
    record: LegacyProduct,
    groups: Readonly<Record<string, string>>,
  ): Promise<ProposedProduct> {
    const languages = record.texts.map((text) => text.language)
    const title = record.texts[0]?.title ?? null
    const existing = await this.catalog.findByLegacyId(record.legacyId)

    if (title === null || title.trim() === '') {
      return {
        legacyId: record.legacyId,
        action: 'refuse',
        title: null,
        reason: 'no title in any language',
        prices: [],
        imageCount: record.images.length,
        languages,
      }
    }

    if (!record.active) {
      // Inactive in the source and unknown here: there is nothing to do, and
      // creating it as a draft would fill the catalog with what was already
      // discarded once.
      return {
        legacyId: record.legacyId,
        action: existing === null ? 'refuse' : 'withdraw',
        title,
        reason: existing === null ? 'inactive in the source' : 'no longer offered by the source',
        prices: [],
        imageCount: record.images.length,
        languages,
      }
    }

    const prices = await this.proposePrices(record, groups, existing?.variants[0]?.id ?? null)
    const changes = existing === null ? undefined : await this.diff(record, existing.id)

    return {
      legacyId: record.legacyId,
      action: existing === null ? 'create' : 'update',
      title,
      prices,
      ...(changes === undefined || Object.keys(changes).length === 0 ? {} : { changes }),
      imageCount: record.images.length,
      languages,
    }
  }

  /**
   * Turns the source's prices into the amounts actually charged.
   *
   * A price held as "retail less 150.00" is computed here, once, against the
   * retail price of the moment - and stored as a number. Keeping the reduction
   * would mean a retail edit silently moves what a hairdresser pays, which is
   * the mechanism this migration exists to end.
   */
  private async proposePrices(
    record: LegacyProduct,
    groups: Readonly<Record<string, string>>,
    variantId: string | null,
  ): Promise<ProposedPrice[]> {
    const prices: ProposedPrice[] = []

    if (record.retailMinor !== null && record.retailMinor > 0) {
      prices.push({
        priceListCode: this.retailList,
        amountMinor: record.retailMinor,
        derivedFrom: 'stated',
        ...(await this.wasPricedAt(variantId, this.retailList)),
      })
    }

    for (const price of record.prices) {
      const listCode = groups[price.group]
      if (listCode === undefined) continue

      const effective = effectiveAmount(price, record.retailMinor)
      if (effective === null) continue

      prices.push({
        priceListCode: listCode,
        amountMinor: effective,
        ...(price.amountMinor === null
          ? {
              derivedFrom: 'retail_less_reduction' as const,
              ...(price.reductionMinor === null ? {} : { reductionMinor: price.reductionMinor }),
              ...(record.retailMinor === null ? {} : { retailMinor: record.retailMinor }),
            }
          : { derivedFrom: 'stated' as const }),
        ...(await this.wasPricedAt(variantId, listCode)),
      })
    }

    return prices
  }

  private async wasPricedAt(variantId: string | null, priceListCode: string): Promise<{ wasMinor?: number }> {
    if (variantId === null) return {}
    const was = await this.pricing.amountOfByCode(variantId, priceListCode)
    return was === null ? {} : { wasMinor: was }
  }

  /** Field-level before and after, limited to what a reviewer would check. */
  private async diff(
    record: LegacyProduct,
    productId: string,
  ): Promise<Record<string, { was: unknown; becomes: unknown }>> {
    const current = await this.catalog.get(productId)
    const changes: Record<string, { was: unknown; becomes: unknown }> = {}

    for (const text of record.texts) {
      const held = current.texts.find((entry) => entry.language === text.language)
      if (held?.title !== text.title) {
        changes[`title.${text.language}`] = { was: held?.title ?? null, becomes: text.title }
      }
    }

    if (current.status === 'withdrawn') {
      changes['status'] = { was: 'withdrawn', becomes: 'published' }
    }
    return changes
  }

  // --- applying ------------------------------------------------------------

  /**
   * Carries out a stored proposal, then checks its own work.
   *
   * The reconciliation afterwards is the point: it re-derives every wholesale
   * price from the source and compares it with what we would now quote. Until
   * that comes out even the import is marked as needing attention, whatever the
   * other counts say - a price that moved in a migration is found by a customer
   * if it is not found here.
   */
  async apply(importId: string): Promise<ImportReport> {
    const run = await this.runById(importId)
    if (run.state === 'applied') {
      throw new ProposalNotApplicableError(
        run.state,
        'This proposal was already applied; propose again to import current data',
      )
    }
    if (run.state !== 'proposed') {
      throw new ProposalNotApplicableError(run.state, `A ${run.state} proposal cannot be applied`)
    }

    const proposal = run.proposal as ImportProposal
    const source = await this.reader.readProducts()
    this.refuseIfStale(proposal, source)

    await this.importCategories()

    const refusals: { legacyId: string; reason: string }[] = []
    let imported = 0
    let skipped = 0
    let failed = 0

    const byLegacyId = new Map(source.map((record) => [record.legacyId, record]))

    for (const proposed of proposal.products) {
      const record = byLegacyId.get(proposed.legacyId)
      if (record === undefined) {
        failed += 1
        refusals.push({ legacyId: proposed.legacyId, reason: 'no longer present in the source' })
        continue
      }

      if (proposed.action === 'refuse') {
        skipped += 1
        refusals.push({ legacyId: proposed.legacyId, reason: proposed.reason ?? 'refused' })
        continue
      }

      try {
        await this.applyOne(proposed, record)
        imported += 1
      } catch (error) {
        failed += 1
        refusals.push({
          legacyId: proposed.legacyId,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const differences = await this.reconcile(source)
    const gaps = await this.findGaps(source)
    const reconciles = imported + skipped + failed === proposal.sourceRecords

    const needsAttention =
      differences.length > 0
        ? `${String(differences.length)} price(s) would now be quoted differently`
        : reconciles
          ? null
          : `counts do not reconcile: ${String(imported + skipped + failed)} of ${String(proposal.sourceRecords)}`

    const report: ImportReport = {
      source: this.reader.sourceName,
      sourceRecords: proposal.sourceRecords,
      imported,
      skipped,
      failed,
      refusals,
      pricesCompared: countPrices(source, await this.reader.groupMapping()),
      differences,
      gaps,
      needsAttention,
    }

    await this.db
      .update(catalogImports)
      .set({
        state: 'applied',
        appliedAt: new Date(),
        appliedBy: tryCurrentScope()?.actor?.id ?? null,
        appliedByName: tryCurrentScope()?.actor?.displayName ?? null,
        imported,
        skipped,
        failed,
        report,
        needsAttention,
      })
      .where(eq(catalogImports.id, importId))

    return report
  }

  /**
   * Refuses a proposal whose arithmetic no longer holds.
   *
   * Every wholesale price held as a reduction was computed against the retail
   * price of the moment the proposal was made. If retail has moved since,
   * applying would store an amount nobody reviewed.
   */
  private refuseIfStale(proposal: ImportProposal, source: readonly LegacyProduct[]): void {
    for (const record of source) {
      const snapshot = proposal.retailSnapshot[record.legacyId]
      if (snapshot === undefined) continue
      if (snapshot === record.retailMinor) continue
      const derived = record.prices.some((price) => price.amountMinor === null)
      if (!derived) continue
      throw new ProposalNotApplicableError(
        'superseded',
        `Retail price of ${record.legacyId} changed since this proposal was made; propose again`,
      )
    }
  }

  private async applyOne(proposed: ProposedProduct, record: LegacyProduct): Promise<void> {
    const existing = await this.catalog.findByLegacyId(record.legacyId)

    if (proposed.action === 'withdraw') {
      if (existing !== null) await this.catalog.setStatus(existing.id, 'withdrawn')
      return
    }

    const texts = record.texts.map(toTextInput)
    const productId =
      existing === null
        ? (await this.catalog.create(await this.creationFor(record, texts))).id
        : (await this.catalog.setTexts(existing.id, texts)).id

    await this.catalog.setStatus(productId, 'published')
    await this.importImages(productId, record)

    const variant = await this.catalog.findVariantBySku(record.sku ?? record.legacyId)
    if (variant === null) throw new ImportError(`No variant for ${record.legacyId} after import`)

    for (const price of proposed.prices) {
      // Overridden with the source as the reason: these amounts are what the
      // shop has been charging, and a guard refusing them would stop a
      // migration over a decision that was taken years ago. They are reported
      // as gaps instead, which is where they can actually be acted on.
      await this.pricing.set({
        variantId: variant.id,
        priceListCode: price.priceListCode,
        amountMinor: price.amountMinor,
        overrideReason: `imported from ${this.reader.sourceName}`,
      })
    }
  }

  /** The whole product, assembled from a source record. */
  private async creationFor(
    record: LegacyProduct,
    texts: readonly ProductTextInput[],
  ): Promise<ProductInput> {
    const brandId = record.brand === undefined ? null : await this.brandIdFor(record.brand)
    const categories = await this.categoryIdsFor(record)

    return {
      legacyId: record.legacyId,
      ...(brandId === null ? {} : { brandId }),
      ...(categories.primary === null ? {} : { primaryCategoryId: categories.primary }),
      ...(categories.others.length === 0 ? {} : { categoryIds: categories.others }),
      texts,
      variants: [
        {
          sku: record.sku ?? record.legacyId,
          ...(record.barcode === undefined ? {} : { barcode: record.barcode }),
          ...(record.purchaseMinor === null ? {} : { plannedPurchasePriceMinor: record.purchaseMinor }),
          ...(record.weightGrams === undefined ? {} : { weightGrams: record.weightGrams }),
        },
      ],
    }
  }

  /**
   * The brand, created once however many products carry it.
   *
   * Five hundred products share thirty-eight brands, so creating one per
   * product fails on the second product of each brand and takes that product
   * down with it - which is what happened the first time this ran against the
   * real catalog: 385 of 557 products lost to a brand that already existed.
   */
  private async brandIdFor(name: string): Promise<string> {
    const cached = this.brandsByName.get(name)
    if (cached !== undefined) return cached

    for (const brand of await this.taxonomy.listBrands()) {
      this.brandsByName.set(brand.name, brand.id)
    }
    const known = this.brandsByName.get(name)
    if (known !== undefined) return known

    const created = await this.taxonomy.createBrand({ name })
    this.brandsByName.set(name, created.id)
    return created.id
  }

  private async importImages(productId: string, record: LegacyProduct): Promise<void> {
    if (record.images.length === 0) return
    const held = await this.images.of(productId)
    const known = new Set(held.map((image) => image.url))

    for (const image of record.images) {
      if (known.has(image.url)) continue
      await this.images.add({
        productId,
        url: image.url,
        origin: this.options.imageOrigin ?? 'imported',
        position: image.position,
        ...(image.alt === undefined ? {} : { alt: image.alt }),
      })
    }
  }

  private async importCategories(): Promise<void> {
    const source = await this.reader.readCategories()
    const created = new Map<string, string>()

    // Parents first, so a child always has one to attach to.
    const ordered = [...source].sort((a, b) => depthOf(a, source) - depthOf(b, source))
    for (const category of ordered) {
      const parentId =
        category.parentLegacyId === null ? null : (created.get(category.parentLegacyId) ?? null)
      // Matched on the previous system's identifier, so a second run updates
      // the tree it built rather than refusing to build it again.
      const held = await this.taxonomy.findCategoryByLegacyId(category.legacyId)
      const stored =
        held ??
        (await this.taxonomy.createCategory({
          name: category.name,
          legacyId: category.legacyId,
          ...(parentId === null ? {} : { parentId }),
        }))
      created.set(category.legacyId, stored.id)
    }
  }

  private async categoryIdsFor(record: LegacyProduct): Promise<{ primary: string | null; others: string[] }> {
    const all = await this.taxonomy.listCategories()
    const byLegacyId = new Map(all.filter((c) => c.legacyId !== null).map((c) => [c.legacyId, c.id]))

    const primary =
      record.primaryCategory === undefined ? null : (byLegacyId.get(record.primaryCategory) ?? null)
    const others = record.categories
      .filter((legacyId) => legacyId !== record.primaryCategory)
      .flatMap((legacyId) => {
        const id = byLegacyId.get(legacyId)
        return id === undefined ? [] : [id]
      })

    return { primary, others }
  }

  // --- checking our own work -----------------------------------------------

  /**
   * Compares every price the source held with what we would now quote.
   *
   * Re-derived from the source rather than from the proposal: a proposal
   * checked against itself proves only that the engine is consistent, not that
   * it is right.
   */
  async verify(source?: readonly LegacyProduct[]): Promise<PriceDifference[]> {
    return this.reconcile(source ?? (await this.reader.readProducts()))
  }

  private async reconcile(source: readonly LegacyProduct[]): Promise<PriceDifference[]> {
    const groups = await this.reader.groupMapping()
    const differences: PriceDifference[] = []

    for (const record of source) {
      if (!record.active) continue
      const variant = await this.catalog.findVariantBySku(record.sku ?? record.legacyId)
      if (variant === null) continue

      for (const price of record.prices) {
        const listCode = groups[price.group]
        if (listCode === undefined) continue
        const expected = effectiveAmount(price, record.retailMinor)
        if (expected === null) continue

        const held = await this.pricing.amountOfByCode(variant.id, listCode)
        if (held === expected) continue

        differences.push({
          legacyId: record.legacyId,
          priceListCode: listCode,
          sourceMinor: expected,
          importedMinor: held ?? 0,
          differenceMinor: (held ?? 0) - expected,
        })
      }
    }

    return differences
  }

  /** Everything worth someone's attention that is not an error. */
  private async findGaps(source: readonly LegacyProduct[]): Promise<ImportGaps> {
    const groups = await this.reader.groupMapping()
    const published = (await this.catalog.languages()).published

    const gaps: MutableGaps = {
      withoutWholesalePrice: [],
      withoutRetailPrice: [],
      wholesaleAtOrBelowPurchase: [],
      wholesaleAtOrAboveRetail: [],
      withoutPurchasePrice: [],
      withoutImages: [],
      withoutTitleInPublishedLanguage: [],
    }

    for (const record of source) {
      if (record.active) collectGaps(record, groups, published, gaps)
    }

    return gaps
  }

  // --- history -------------------------------------------------------------

  async runById(importId: string): Promise<typeof catalogImports.$inferSelect> {
    const [row] = await this.db.select().from(catalogImports).where(eq(catalogImports.id, importId)).limit(1)
    if (row === undefined) throw new ImportError(`No import run ${importId}`)
    return row
  }

  /** Past runs, newest first, so a report can be read long afterwards. */
  async history(limit = 20): Promise<(typeof catalogImports.$inferSelect)[]> {
    return this.db.select().from(catalogImports).orderBy(desc(catalogImports.proposedAt)).limit(limit)
  }
}

/** How deep a category sits, so parents can be created before children. */
function depthOf(
  category: { legacyId: string; parentLegacyId: string | null },
  all: readonly { legacyId: string; parentLegacyId: string | null }[],
  seen = new Set<string>(),
): number {
  if (category.parentLegacyId === null || seen.has(category.legacyId)) return 0
  seen.add(category.legacyId)
  const parent = all.find((entry) => entry.legacyId === category.parentLegacyId)
  return parent === undefined ? 0 : 1 + depthOf(parent, all, seen)
}

function countPrices(source: readonly LegacyProduct[], groups: Readonly<Record<string, string>>): number {
  return source.reduce(
    (total, record) => total + record.prices.filter((price) => groups[price.group] !== undefined).length,
    0,
  )
}

/** The amount actually charged, whichever form the source held it in. */
export function effectiveAmount(price: LegacyPrice, retailMinor: number | null): number | null {
  if (price.amountMinor !== null) return price.amountMinor
  if (price.reductionMinor === null || retailMinor === null) return null
  const effective = retailMinor - price.reductionMinor
  return effective < 0 ? null : effective
}

function tally(products: readonly ProposedProduct[]): Record<ProposedAction, number> {
  const counts: Record<ProposedAction, number> = { create: 0, update: 0, withdraw: 0, refuse: 0 }
  for (const product of products) counts[product.action] += 1
  return counts
}

type MutableGaps = { -readonly [K in keyof ImportGaps]: string[] }

function toTextInput(text: LegacyText): ProductTextInput {
  return {
    language: text.language,
    title: text.title,
    ...(text.description === undefined ? {} : { description: text.description }),
    ...(text.shortDescription === undefined ? {} : { shortDescription: text.shortDescription }),
    ...(text.metaTitle === undefined ? {} : { metaTitle: text.metaTitle }),
    ...(text.metaDescription === undefined ? {} : { metaDescription: text.metaDescription }),
  }
}

/** What the wholesale lists would charge for this record, if anything. */
function wholesaleOf(record: LegacyProduct, groups: Readonly<Record<string, string>>): number | undefined {
  const amounts = record.prices
    .filter((price) => groups[price.group] !== undefined)
    .map((price) => effectiveAmount(price, record.retailMinor))
  return amounts.find((amount) => amount !== null) ?? undefined
}

/**
 * Adds one record to the gap lists.
 *
 * None of these stops the import. They are things someone should decide about -
 * a product a hairdresser pays retail for, a price below cost - and a migration
 * that refused them would stall over decisions taken years ago.
 */
function collectGaps(
  record: LegacyProduct,
  groups: Readonly<Record<string, string>>,
  published: readonly string[],
  gaps: MutableGaps,
): void {
  const wholesale = wholesaleOf(record, groups)
  const retail = record.retailMinor
  const hasRetail = retail !== null && retail > 0

  if (wholesale === undefined) gaps.withoutWholesalePrice.push(record.legacyId)
  if (!hasRetail) {
    if (wholesale !== undefined) gaps.withoutRetailPrice.push(record.legacyId)
  } else if (wholesale !== undefined && wholesale >= retail) {
    gaps.wholesaleAtOrAboveRetail.push(record.legacyId)
  }

  if (record.purchaseMinor === null || record.purchaseMinor <= 0) {
    gaps.withoutPurchasePrice.push(record.legacyId)
  } else if (wholesale !== undefined && wholesale <= record.purchaseMinor) {
    gaps.wholesaleAtOrBelowPurchase.push(record.legacyId)
  }

  if (record.images.length === 0) gaps.withoutImages.push(record.legacyId)

  const translated = published.every((language) =>
    record.texts.some((text) => text.language === language && text.title.trim() !== ''),
  )
  if (!translated) gaps.withoutTitleInPublishedLanguage.push(record.legacyId)
}
