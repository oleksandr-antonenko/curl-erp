import {
  type ChannelCapabilities,
  ChannelError,
  type ChannelOrder,
  type ChannelOrderStatusUpdate,
  type ChannelPrice,
  type ChannelProductInput,
  type ChannelProductResult,
  type ChannelStockLevel,
  type ChannelStockReport,
  type SalesChannelAdapter,
} from './contract.js'

export interface MemoryChannelOptions {
  readonly id?: string
  readonly capabilities?: Partial<ChannelCapabilities>
  /** Fails every call, for testing how the core copes with an outage. */
  readonly unreachable?: boolean
}

export interface MemoryListing {
  readonly externalId: string
  readonly product: ChannelProductInput
  prices: ChannelPrice[]
}

/**
 * A channel that exists only in memory.
 *
 * Serves three purposes: it is the reference implementation an adapter author
 * reads, it is what the contract suite is proved against, and it lets the core
 * be tested end to end without a shop. Its behaviour is deliberately strict -
 * an adapter that only works against a forgiving fake teaches nothing.
 */
export class MemoryChannelAdapter implements SalesChannelAdapter {
  readonly id: string
  readonly capabilities: ChannelCapabilities

  readonly listings = new Map<string, MemoryListing>()
  readonly variantIndex = new Map<string, string>()
  /**
   * Availability per variant, not per product.
   *
   * A shop that tracked it per product would report the same number for a
   * 250 ml bottle and a 500 ml one, and every reconciliation would "correct"
   * one of them into the other.
   */
  readonly stockByVariant = new Map<string, number>()
  readonly statuses: ChannelOrderStatusUpdate[] = []
  orders: ChannelOrder[] = []
  /** Every call recorded, so tests can assert what the core actually sent. */
  readonly calls: { method: string; at: Date }[] = []

  private unreachable: boolean
  private sequence = 0

  constructor(options: MemoryChannelOptions = {}) {
    this.id = options.id ?? 'memory'
    this.capabilities = {
      customerGroups: true,
      priceLists: true,
      stockLevels: true,
      orderStatus: true,
      stockReporting: true,
      ...options.capabilities,
    }
    this.unreachable = options.unreachable ?? false
  }

  /** Simulates an outage, so retry and queue behaviour can be observed. */
  setUnreachable(value: boolean): void {
    this.unreachable = value
  }

  private guard(method: string): void {
    this.calls.push({ method, at: new Date() })
    if (this.unreachable) throw new ChannelError(this.id, `${method}: channel is unreachable`)
  }

  async publishProduct(
    product: ChannelProductInput,
    existingExternalId?: string,
  ): Promise<ChannelProductResult> {
    this.guard('publishProduct')

    const externalId = existingExternalId ?? `${this.id}-p${++this.sequence}`
    const existing = this.listings.get(externalId)

    const variants = product.variants.map((variant) => {
      const known = this.variantIndex.get(variant.localId)
      const variantExternalId = known ?? `${externalId}-v${variant.localId}`
      this.variantIndex.set(variant.localId, variantExternalId)
      return { localId: variant.localId, externalId: variantExternalId }
    })

    this.listings.set(externalId, { externalId, product, prices: existing?.prices ?? [] })

    return { externalId, variants }
  }

  async unpublishProduct(externalId: string): Promise<void> {
    this.guard('unpublishProduct')
    // Tolerates an absent product: the core retries, and a second delete of
    // something already gone is the normal case, not an error.
    this.listings.delete(externalId)
  }

  async publishStock(levels: readonly ChannelStockLevel[]): Promise<void> {
    this.guard('publishStock')
    for (const level of levels) {
      if (level.available < 0) {
        throw new ChannelError(this.id, `negative availability for ${level.variantLocalId}`)
      }
      if (this.findByVariant(level.variantLocalId) !== null) {
        this.stockByVariant.set(level.variantLocalId, level.available)
      }
    }
  }

  async publishPrices(prices: readonly ChannelPrice[]): Promise<void> {
    this.guard('publishPrices')
    for (const price of prices) {
      if (price.customerGroup !== undefined && !this.capabilities.customerGroups) {
        throw new ChannelError(this.id, 'this channel cannot hold a price per customer group')
      }
      const listing = this.findByVariant(price.variantLocalId)
      if (listing === null) continue
      listing.prices = [
        ...listing.prices.filter((entry) => entry.customerGroup !== price.customerGroup),
        price,
      ]
    }
  }

  async fetchOrders(since: Date): Promise<readonly ChannelOrder[]> {
    this.guard('fetchOrders')
    return this.orders
      .filter((order) => order.placedAt > since)
      .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime())
  }

  async publishOrderStatus(update: ChannelOrderStatusUpdate): Promise<void> {
    this.guard('publishOrderStatus')
    this.statuses.push(update)
  }

  async fetchStock(): Promise<readonly ChannelStockReport[]> {
    this.guard('fetchStock')
    return [...this.variantIndex.entries()].map(([localId, externalVariantId]) => ({
      externalVariantId,
      available: this.stockByVariant.get(localId) ?? 0,
    }))
  }

  /** Places an order on the channel, as a customer would. */
  placeOrder(order: ChannelOrder): void {
    this.orders.push(order)
  }

  /** Sets what the channel reports for a variant, to create drift on purpose. */
  setReportedStock(variantLocalId: string, available: number): void {
    this.stockByVariant.set(variantLocalId, available)
  }

  /** What the channel currently shows for a variant. */
  availabilityOf(variantLocalId: string): number {
    return this.stockByVariant.get(variantLocalId) ?? 0
  }

  private findByVariant(variantLocalId: string): MemoryListing | null {
    for (const listing of this.listings.values()) {
      if (listing.product.variants.some((variant) => variant.localId === variantLocalId)) {
        return listing
      }
    }
    return null
  }
}

/** Entry point an adapter package must export. */
export function createChannelAdapter(options: Readonly<Record<string, unknown>> = {}): SalesChannelAdapter {
  return new MemoryChannelAdapter(options as MemoryChannelOptions)
}
