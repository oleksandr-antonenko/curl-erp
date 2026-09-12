import { and, eq, inArray, sql } from 'drizzle-orm'
import { productTexts, productVariants } from '../catalog/schema.js'
import { recordChange } from '../change-feed/record.js'
import type { Executor } from '../change-feed/types.js'
import { Contractors } from '../contractors/contractors.js'
import type { Database } from '../db/client.js'
import { Stock } from '../stock/stock.js'
import { requireActor } from '../tenancy/context.js'
import { type MatchableVariant, type MatchCandidate, proposeMatches } from './matching.js'
import { distributeByQuantity, reconcile } from './money.js'
import type { InvoiceRecogniser, RecognisedInvoice } from './recognition.js'
import { RecognitionUnavailableError } from './recognition.js'
import {
  type SupplierReceiptLinePartRow,
  type SupplierReceiptLineRow,
  type SupplierReceiptRow,
  supplierReceiptLineParts,
  supplierReceiptLines,
  supplierReceipts,
} from './schema.js'

export class ReceiptError extends Error {
  override readonly name = 'ReceiptError'
}

export class ReceiptNotFoundError extends ReceiptError {
  constructor(readonly id: string) {
    super(`No supplier receipt with id ${id}`)
  }
}

/** Already posted. Posting again would write the stock a second time. */
export class AlreadyPostedError extends ReceiptError {
  constructor(
    readonly id: string,
    readonly postedAt: Date,
  ) {
    super(`Receipt ${id} was already posted at ${postedAt.toISOString()}`)
  }
}

/** Some line has not been resolved to anything we hold. */
export class UnresolvedLinesError extends ReceiptError {
  constructor(readonly lines: readonly { readonly position: number; readonly rawName: string }[]) {
    super(`Unresolved lines: ${lines.map((line) => `${String(line.position)} (${line.rawName})`).join(', ')}`)
  }
}

/** No document and no word about where the figures came from. */
export class UnevidencedError extends ReceiptError {
  constructor(readonly id: string) {
    super(`Receipt ${id} has neither a document nor a stated source`)
  }
}

export interface ReceiptLineInput {
  readonly rawName: string
  readonly unit?: string
  readonly quantity: number
  /** This line's amount. Give this, or let a group amount be distributed. */
  readonly amountMinor?: number
}

/** A cost known for a group of lines rather than per line. */
export interface ReceiptLineGroupInput {
  readonly amountMinor: number
  readonly lines: readonly ReceiptLineInput[]
}

export interface CreateReceiptInput {
  readonly legalEntityId: string
  readonly supplierId: string
  readonly warehouseId: string
  readonly number?: string
  readonly documentDate?: Date
  readonly statedTotalMinor: number
  readonly currency?: string
  readonly documentId?: string
  readonly sourceNote?: string
  readonly lines?: readonly ReceiptLineInput[]
  readonly groups?: readonly ReceiptLineGroupInput[]
  readonly recognition?: RecognisedInvoice
}

export interface ReceiptLinePart {
  readonly id: string
  readonly variantId: string
  readonly quantity: number
  readonly amountMinor: number
  readonly lotId: string | null
}

export interface ReceiptLine {
  readonly id: string
  readonly position: number
  readonly rawName: string
  readonly unit: string | null
  readonly quantity: number
  readonly amountMinor: number
  readonly parts: readonly ReceiptLinePart[]
}

export interface Receipt {
  readonly id: string
  readonly legalEntityId: string
  readonly number: string | null
  readonly supplierId: string
  readonly warehouseId: string
  readonly documentDate: Date | null
  readonly statedTotalMinor: number
  readonly currency: string
  readonly state: 'draft' | 'posted'
  readonly documentId: string | null
  readonly sourceNote: string | null
  readonly obligationMinor: number | null
  readonly postedAt: Date | null
  readonly lines: readonly ReceiptLine[]
  /** What the recogniser returned, kept beside what a person accepted. */
  readonly recognition: RecognisedInvoice | null
}

/**
 * How goods and their cost get in.
 *
 * Nothing here posts on its own. Recognition fills a draft in, a person reads
 * it, and posting is a separate call that takes a lock and writes stock once.
 * The draft is the same row in a different state, so the corrections a person
 * makes sit on the record they will read a year from now.
 */
export class SupplierReceipts {
  constructor(
    private readonly db: Database,
    private readonly stock: Stock = new Stock(db),
    private readonly contractors: Contractors = new Contractors(db),
    /** Absent by default. The core has to work with nothing installed. */
    private readonly recogniser?: InvoiceRecogniser,
  ) {}

  get recognitionAvailable(): boolean {
    return this.recogniser !== undefined
  }

  /**
   * Reads a document into a proposal.
   *
   * Returns the proposal rather than a receipt, so that the caller - and the
   * person reading the screen - sees what the machine claims before any of it
   * is written down as ours.
   */
  async recognise(input: {
    readonly content: Uint8Array
    readonly mediaType: string
    readonly fileName?: string
  }): Promise<RecognisedInvoice> {
    if (this.recogniser === undefined) throw new RecognitionUnavailableError()
    return this.recogniser.read(input)
  }

  /**
   * What a printed line might be, best first.
   *
   * Returns candidates and stops. Accepting one is `resolveLine`, called by a
   * person: an invoice line often does not contain enough to tell two of our
   * items apart, and a matcher that picked anyway would be wrong in a way
   * nobody audits.
   */
  async proposeFor(lineId: string, limit = 5): Promise<readonly MatchCandidate[]> {
    const [line] = await this.db
      .select()
      .from(supplierReceiptLines)
      .where(eq(supplierReceiptLines.id, lineId))
      .limit(1)
    if (line === undefined) throw new ReceiptError(`No receipt line with id ${lineId}`)

    const rows = await this.db
      .select({
        variantId: productVariants.id,
        sku: productVariants.sku,
        variantTitle: productVariants.title,
        productTitle: productTexts.title,
      })
      .from(productVariants)
      .leftJoin(productTexts, eq(productTexts.productId, productVariants.productId))

    // One row per variant: a product carries a title per language, and the
    // same variant must not compete with itself.
    const byVariant = new Map<string, MatchableVariant>()
    for (const row of rows) {
      const label = [row.productTitle, row.variantTitle].filter((part) => part !== null).join(' ')
      const existing = byVariant.get(row.variantId)
      if (existing === undefined || existing.label.length < label.length) {
        byVariant.set(row.variantId, { variantId: row.variantId, sku: row.sku, label })
      }
    }

    return proposeMatches(line.rawName, [...byVariant.values()], limit)
  }

  async create(input: CreateReceiptInput): Promise<Receipt> {
    if (!Number.isInteger(input.statedTotalMinor) || input.statedTotalMinor < 0) {
      throw new ReceiptError('A stated total must be integer minor units, not negative')
    }
    await this.contractors.require(input.supplierId, 'supplier')

    const lines = resolveLineAmounts(input)
    // Lines may be filled in later, but whatever is given now must add up: a
    // draft that already disagrees with its own paper is a draft nobody
    // notices is wrong.
    if (lines.length > 0) {
      reconcile(
        lines.map((line) => line.amountMinor),
        input.statedTotalMinor,
      )
    }

    const actor = requireActor('A supplier receipt')
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(supplierReceipts)
        .values({
          legalEntityId: input.legalEntityId,
          number: input.number ?? null,
          supplierId: input.supplierId,
          warehouseId: input.warehouseId,
          documentDate: input.documentDate ?? null,
          statedTotalMinor: input.statedTotalMinor,
          ...(input.currency === undefined ? {} : { currency: input.currency }),
          documentId: input.documentId ?? null,
          sourceNote: blankToNull(input.sourceNote),
          recognition: input.recognition ?? null,
          createdActorType: actor.type,
          createdActorId: actor.id,
          createdActorConversationId: actor.conversationId ?? null,
        })
        .returning()
      if (row === undefined) throw new ReceiptError('Failed to record the receipt')

      if (lines.length > 0) {
        await tx.insert(supplierReceiptLines).values(
          lines.map((line, index) => ({
            receiptId: row.id,
            position: index + 1,
            rawName: line.rawName,
            unit: line.unit ?? null,
            quantity: line.quantity,
            amountMinor: line.amountMinor,
            recognised: line.recognised ?? null,
          })),
        )
      }

      await recordChange(tx, { entityType: 'supplier_receipt', entityId: row.id, kind: 'created' })
      return this.load(tx, row.id)
    })
  }

  async find(id: string): Promise<Receipt | null> {
    const [row] = await this.db.select().from(supplierReceipts).where(eq(supplierReceipts.id, id)).limit(1)
    if (row === undefined) return null
    return this.load(this.db, id)
  }

  /**
   * Says what a line turned out to be.
   *
   * One line may become several parts - one printed "Дозатор 24/410, 1 450" is
   * 750 of one thing and 700 of another - and the parts must account for the
   * line exactly, in both count and money. Amounts may be omitted, in which
   * case the line's amount is split by quantity with nothing lost.
   */
  async resolveLine(
    lineId: string,
    parts: readonly {
      readonly variantId: string
      readonly quantity: number
      readonly amountMinor?: number
    }[],
  ): Promise<ReceiptLine> {
    if (parts.length === 0) throw new ReceiptError('A line resolves to at least one variant')

    return this.db.transaction(async (tx) => {
      const [line] = await tx
        .select()
        .from(supplierReceiptLines)
        .where(eq(supplierReceiptLines.id, lineId))
        .limit(1)
      if (line === undefined) throw new ReceiptError(`No receipt line with id ${lineId}`)
      await this.guardDraft(tx, line.receiptId)

      const quantities = parts.map((part) => part.quantity)
      const quantitySum = quantities.reduce((sum, quantity) => sum + quantity, 0)
      if (quantitySum !== line.quantity) {
        throw new ReceiptError(`Parts count ${String(quantitySum)} but the line is ${String(line.quantity)}`)
      }

      const stated = parts.map((part) => part.amountMinor)
      const amounts = stated.every((amount) => amount === undefined)
        ? distributeByQuantity(line.amountMinor, quantities)
        : stated.map((amount) => {
            if (amount === undefined) {
              throw new ReceiptError('Give an amount for every part, or for none of them')
            }
            return amount
          })
      reconcile(amounts, line.amountMinor)

      await tx.delete(supplierReceiptLineParts).where(eq(supplierReceiptLineParts.lineId, lineId))
      await tx.insert(supplierReceiptLineParts).values(
        parts.map((part, index) => ({
          lineId,
          variantId: part.variantId,
          quantity: part.quantity,
          amountMinor: amounts[index] ?? 0,
        })),
      )

      const loaded = await this.load(tx, line.receiptId)
      const updated = loaded.lines.find((candidate) => candidate.id === lineId)
      if (updated === undefined) throw new ReceiptError('Failed to reload the line')
      return updated
    })
  }

  /**
   * Makes the receipt true: stock arrives and the debt is on record.
   *
   * One transaction, and the receipt row is locked first, so two people
   * pressing the button at the same moment produce one posting and one
   * refusal rather than two sets of lots.
   *
   * It writes no payment. Money leaving is a different event, in a different
   * amount, on a different day - and often already recorded before the goods
   * are even entered.
   */
  async post(id: string): Promise<Receipt> {
    const actor = requireActor('A posting')

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(supplierReceipts)
        .where(eq(supplierReceipts.id, id))
        .limit(1)
        .for('update')
      if (row === undefined) throw new ReceiptNotFoundError(id)
      if (row.state === 'posted') {
        throw new AlreadyPostedError(id, row.postedAt ?? new Date(0))
      }
      if (row.documentId === null && blankToNull(row.sourceNote) === null) {
        throw new UnevidencedError(id)
      }

      const receipt = await this.load(tx, id)
      assertPostable(receipt, row.statedTotalMinor)
      await this.createLots(tx, receipt, row)

      await tx
        .update(supplierReceipts)
        .set({
          state: 'posted',
          // What we owe for this delivery. Settling it is the ledger's work.
          obligationMinor: row.statedTotalMinor,
          postedActorType: actor.type,
          postedActorId: actor.id,
          postedAt: sql`now()`,
        })
        .where(and(eq(supplierReceipts.id, id), eq(supplierReceipts.state, 'draft')))

      await recordChange(tx, { entityType: 'supplier_receipt', entityId: id, kind: 'updated' })
      return this.load(tx, id)
    })
  }

  /** One lot per resolved part, each remembering the lot it produced. */
  private async createLots(executor: Executor, receipt: Receipt, row: SupplierReceiptRow): Promise<void> {
    for (const line of receipt.lines) {
      for (const part of line.parts) {
        const lot = await this.stock.receive(executor, {
          variantId: part.variantId,
          warehouseId: row.warehouseId,
          quantity: part.quantity,
          amountMinor: part.amountMinor,
          currency: row.currency,
          sourceType: 'supplier_receipt',
          sourceId: receipt.id,
          ...(row.documentDate === null ? {} : { receivedAt: row.documentDate }),
        })
        await executor
          .update(supplierReceiptLineParts)
          .set({ lotId: lot.id })
          .where(eq(supplierReceiptLineParts.id, part.id))
      }
    }
  }

  /** Refuses to change a receipt whose numbers are already in the accounts. */
  private async guardDraft(executor: Executor, receiptId: string): Promise<void> {
    const [row] = await executor
      .select()
      .from(supplierReceipts)
      .where(eq(supplierReceipts.id, receiptId))
      .limit(1)
    if (row === undefined) throw new ReceiptNotFoundError(receiptId)
    if (row.state === 'posted') throw new AlreadyPostedError(receiptId, row.postedAt ?? new Date(0))
  }

  private async load(executor: Executor, id: string): Promise<Receipt> {
    const [row] = await executor.select().from(supplierReceipts).where(eq(supplierReceipts.id, id)).limit(1)
    if (row === undefined) throw new ReceiptNotFoundError(id)

    const lineRows = await executor
      .select()
      .from(supplierReceiptLines)
      .where(eq(supplierReceiptLines.receiptId, id))
      .orderBy(supplierReceiptLines.position)

    const partRows =
      lineRows.length === 0
        ? []
        : await executor
            .select()
            .from(supplierReceiptLineParts)
            .where(
              inArray(
                supplierReceiptLineParts.lineId,
                lineRows.map((line) => line.id),
              ),
            )

    return toReceipt(row, lineRows, partRows)
  }
}

/**
 * Everything that must hold before stock is written.
 *
 * Separate from the writing so the refusals read as a list rather than being
 * buried in the loop that would have done the damage.
 */
function assertPostable(receipt: Receipt, statedTotalMinor: number): void {
  if (receipt.lines.length === 0) throw new ReceiptError('A receipt with no lines posts nothing')

  const unresolved = receipt.lines.filter((line) => line.parts.length === 0)
  if (unresolved.length > 0) {
    throw new UnresolvedLinesError(
      unresolved.map((line) => ({ position: line.position, rawName: line.rawName })),
    )
  }

  reconcile(
    receipt.lines.map((line) => line.amountMinor),
    statedTotalMinor,
  )
}

/** Line amounts, whether stated per line or known only for a group. */
function resolveLineAmounts(
  input: CreateReceiptInput,
): readonly (ReceiptLineInput & { readonly amountMinor: number; readonly recognised?: unknown })[] {
  const fromLines = (input.lines ?? []).map((line) => {
    if (line.amountMinor === undefined) {
      throw new ReceiptError(`Line "${line.rawName}" has no amount; put it in a group instead`)
    }
    return { ...line, amountMinor: line.amountMinor }
  })

  const fromGroups = (input.groups ?? []).flatMap((group) => {
    const shares = distributeByQuantity(
      group.amountMinor,
      group.lines.map((line) => line.quantity),
    )
    return group.lines.map((line, index) => ({ ...line, amountMinor: shares[index] ?? 0 }))
  })

  return [...fromLines, ...fromGroups]
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === null || trimmed === '' ? null : trimmed
}

function toReceipt(
  row: SupplierReceiptRow,
  lineRows: readonly SupplierReceiptLineRow[],
  partRows: readonly SupplierReceiptLinePartRow[],
): Receipt {
  return {
    id: row.id,
    legalEntityId: row.legalEntityId,
    number: row.number,
    supplierId: row.supplierId,
    warehouseId: row.warehouseId,
    documentDate: row.documentDate,
    statedTotalMinor: row.statedTotalMinor,
    currency: row.currency,
    state: row.state as 'draft' | 'posted',
    documentId: row.documentId,
    sourceNote: row.sourceNote,
    obligationMinor: row.obligationMinor,
    postedAt: row.postedAt,
    recognition: (row.recognition as RecognisedInvoice | null) ?? null,
    lines: lineRows.map((line) => ({
      id: line.id,
      position: line.position,
      rawName: line.rawName,
      unit: line.unit,
      quantity: line.quantity,
      amountMinor: line.amountMinor,
      parts: partRows
        .filter((part) => part.lineId === line.id)
        .map((part) => ({
          id: part.id,
          variantId: part.variantId,
          quantity: part.quantity,
          amountMinor: part.amountMinor,
          lotId: part.lotId,
        })),
    })),
  }
}
