import { and, eq, sql } from 'drizzle-orm'
import { recordChange } from '../change-feed/record.js'
import type { Executor } from '../change-feed/types.js'
import type { Database } from '../db/client.js'
import { requireActor } from '../tenancy/context.js'
import { type StockLotRow, stockLots, type WarehouseRow, warehouses } from './schema.js'

export class StockError extends Error {
  override readonly name = 'StockError'
}

/** Taking this much would leave a lot holding less than nothing. */
export class InsufficientLotError extends StockError {
  constructor(
    readonly lotId: string,
    readonly remaining: number,
    readonly requested: number,
  ) {
    super(`Lot ${lotId} holds ${String(remaining)}; ${String(requested)} was asked for`)
  }
}

export interface Warehouse {
  readonly id: string
  readonly code: string
  readonly name: string
}

export interface StockLot {
  readonly id: string
  readonly variantId: string
  readonly warehouseId: string
  readonly quantityReceived: number
  readonly quantityRemaining: number
  readonly amountMinor: number
  readonly currency: string
  readonly sourceType: string
  readonly sourceId: string
  readonly receivedAt: Date
}

/**
 * What a document says arrived.
 *
 * `sourceType` and `sourceId` are required, not optional: a lot exists because
 * a document brought it in, and one that cannot name its document is a number
 * somebody typed.
 */
export interface ReceiveLotInput {
  readonly variantId: string
  readonly warehouseId: string
  readonly quantity: number
  readonly amountMinor: number
  readonly currency?: string
  readonly sourceType: string
  readonly sourceId: string
  readonly receivedAt?: Date
}

export interface OnHand {
  readonly variantId: string
  readonly quantity: number
  /** What the remaining pieces cost, summed across lots. Integer minor units. */
  readonly valueMinor: number
}

/**
 * Stock, held as lots.
 *
 * There is no method here that writes a quantity or a cost. Everything that
 * changes stock takes a document, because a figure that can be set directly
 * stops being evidence of anything the moment somebody corrects it by hand -
 * and the lot it belonged to can never be reconstructed afterwards.
 */
export class Stock {
  constructor(private readonly db: Database) {}

  async createWarehouse(input: { readonly code: string; readonly name: string }): Promise<Warehouse> {
    const [row] = await this.db
      .insert(warehouses)
      .values({ code: input.code.trim(), name: input.name.trim() })
      .returning()
    if (row === undefined) throw new StockError('Failed to record the warehouse')
    return toWarehouse(row)
  }

  async findWarehouseByCode(code: string): Promise<Warehouse | null> {
    const [row] = await this.db.select().from(warehouses).where(eq(warehouses.code, code)).limit(1)
    return row === undefined ? null : toWarehouse(row)
  }

  /**
   * Records a lot arriving.
   *
   * Takes the executor so the lot, the document that caused it and the journal
   * event are one transaction: a rolled-back receipt leaves no stock, and
   * stock that exists always has a posted document behind it.
   */
  async receive(executor: Executor, input: ReceiveLotInput): Promise<StockLot> {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new StockError('A received quantity must be a whole number of at least one')
    }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) {
      throw new StockError('An amount must be integer minor units, not negative')
    }

    const actor = requireActor('A stock lot')
    const [row] = await executor
      .insert(stockLots)
      .values({
        variantId: input.variantId,
        warehouseId: input.warehouseId,
        quantityReceived: input.quantity,
        quantityRemaining: input.quantity,
        amountMinor: input.amountMinor,
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
        actorType: actor.type,
        actorId: actor.id,
      })
      .returning()
    if (row === undefined) throw new StockError('Failed to record the lot')

    await recordChange(executor, {
      entityType: 'stock_lot',
      entityId: row.id,
      kind: 'created',
    })

    return toLot(row)
  }

  /**
   * Takes from a lot, refusing to go below zero.
   *
   * Nothing in this change calls it yet - consumption is a later capability -
   * but the guard belongs with the lot rather than with whoever consumes it,
   * so that no consumer can be the one that gets it wrong.
   */
  async take(executor: Executor, lotId: string, quantity: number): Promise<StockLot> {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new StockError('A taken quantity must be a whole number of at least one')
    }

    const [row] = await executor
      .update(stockLots)
      .set({ quantityRemaining: sql`${stockLots.quantityRemaining} - ${quantity}` })
      .where(and(eq(stockLots.id, lotId), sql`${stockLots.quantityRemaining} >= ${quantity}`))
      .returning()

    if (row === undefined) {
      const [current] = await executor.select().from(stockLots).where(eq(stockLots.id, lotId)).limit(1)
      if (current === undefined) throw new StockError(`No lot with id ${lotId}`)
      throw new InsufficientLotError(lotId, current.quantityRemaining, quantity)
    }
    return toLot(row)
  }

  async lotsOf(variantId: string, warehouseId?: string): Promise<readonly StockLot[]> {
    const conditions = [eq(stockLots.variantId, variantId)]
    if (warehouseId !== undefined) conditions.push(eq(stockLots.warehouseId, warehouseId))
    const rows = await this.db
      .select()
      .from(stockLots)
      .where(and(...conditions))
      .orderBy(stockLots.receivedAt, stockLots.id)
    return rows.map(toLot)
  }

  /**
   * What is on hand, summed from the lots.
   *
   * Derived on every read rather than kept as a counter. A counter and its lots
   * can disagree, and when they do there is no way to tell which one lied.
   */
  async onHand(variantId: string, warehouseId?: string): Promise<OnHand> {
    const lots = await this.lotsOf(variantId, warehouseId)
    let quantity = 0
    let valueMinor = 0
    for (const lot of lots) {
      quantity += lot.quantityRemaining
      // The remaining pieces' share of what the whole lot cost, kept in minor
      // units. Rounded once here, never stored.
      valueMinor += Math.round((lot.amountMinor * lot.quantityRemaining) / lot.quantityReceived)
    }
    return { variantId, quantity, valueMinor }
  }
}

function toWarehouse(row: WarehouseRow): Warehouse {
  return { id: row.id, code: row.code, name: row.name }
}

function toLot(row: StockLotRow): StockLot {
  return {
    id: row.id,
    variantId: row.variantId,
    warehouseId: row.warehouseId,
    quantityReceived: row.quantityReceived,
    quantityRemaining: row.quantityRemaining,
    amountMinor: row.amountMinor,
    currency: row.currency,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    receivedAt: row.receivedAt,
  }
}
