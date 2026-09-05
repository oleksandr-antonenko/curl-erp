/**
 * The contract between the core and a sales channel.
 *
 * The core owns the catalog, the stock, the money and the customer; a channel
 * shows some of that outward and brings orders back. Everything a channel can
 * do is declared here, so a second channel is a new implementation rather than
 * a second set of assumptions spread through the core - and so an adapter can
 * be sold, withheld or replaced without touching anything else.
 */

/** What a channel is able to enforce or represent. */
export interface ChannelCapabilities {
  /** Can restrict visibility and price by customer group. */
  readonly customerGroups: boolean
  /** Accepts more than one price list. */
  readonly priceLists: boolean
  /** Tracks stock levels rather than assuming everything is available. */
  readonly stockLevels: boolean
  /** Accepts order status updates. */
  readonly orderStatus: boolean
  /** Can report its own stock, so drift can be detected. */
  readonly stockReporting: boolean
}

export interface ChannelMedia {
  readonly url: string
  readonly alt?: string
  readonly position?: number
}

export interface ChannelVariantInput {
  /** Identifier in the core. The mapping to the channel's own id is kept here. */
  readonly localId: string
  readonly sku: string
  readonly title: string
  /** Minor units, e.g. kopecks. Never a floating-point amount. */
  readonly priceMinor: number
  readonly currency: string
  readonly options?: Readonly<Record<string, string>>
  readonly barcode?: string
  readonly weightGrams?: number
}

export interface ChannelProductInput {
  readonly localId: string
  readonly title: string
  readonly description?: string
  readonly handle?: string
  readonly brand?: string
  readonly categories?: readonly string[]
  readonly attributes?: Readonly<Record<string, string | number | boolean>>
  readonly media?: readonly ChannelMedia[]
  readonly variants: readonly ChannelVariantInput[]
  /** Groups allowed to see and buy. Empty means everyone. */
  readonly restrictedToGroups?: readonly string[]
}

export interface ChannelProductResult {
  readonly externalId: string
  readonly variants: readonly { readonly localId: string; readonly externalId: string }[]
}

export interface ChannelStockLevel {
  readonly variantLocalId: string
  /** What the channel should present as available. */
  readonly available: number
}

export interface ChannelPrice {
  readonly variantLocalId: string
  readonly priceMinor: number
  readonly currency: string
  /** Group this price applies to. Omitted means the default price. */
  readonly customerGroup?: string
}

export interface ChannelOrderLine {
  /** The channel's own variant identifier; the core maps it back. */
  readonly externalVariantId: string
  readonly sku?: string
  readonly quantity: number
  /** What the customer was actually charged, in minor units. */
  readonly unitPriceMinor: number
}

export interface ChannelCustomer {
  readonly externalId: string
  readonly email?: string
  readonly phone?: string
  readonly name?: string
}

export interface ChannelOrder {
  readonly externalId: string
  readonly placedAt: Date
  readonly currency: string
  readonly totalMinor: number
  readonly lines: readonly ChannelOrderLine[]
  readonly customer: ChannelCustomer
  readonly deliveryNote?: string
  readonly raw?: Readonly<Record<string, unknown>>
}

export type ChannelOrderStatus = 'confirmed' | 'paid' | 'shipped' | 'cancelled' | 'refunded'

export interface ChannelOrderStatusUpdate {
  readonly externalOrderId: string
  readonly status: ChannelOrderStatus
  readonly trackingReference?: string
  readonly note?: string
}

export interface ChannelStockReport {
  readonly externalVariantId: string
  readonly available: number
}

/**
 * An adapter for one sales channel.
 *
 * Every method may be called again with the same input: the core retries, and a
 * channel that creates a second product on the second call turns a network
 * hiccup into a duplicate listing.
 */
export interface SalesChannelAdapter {
  /** Stable identifier, e.g. `storefront`. Used in mappings and in the queue. */
  readonly id: string
  readonly capabilities: ChannelCapabilities

  /** Creates or updates a product. Returns the channel's identifiers. */
  publishProduct(product: ChannelProductInput, existingExternalId?: string): Promise<ChannelProductResult>

  /** Removes a product from sale. Must tolerate an already-absent product. */
  unpublishProduct(externalId: string): Promise<void>

  publishStock(levels: readonly ChannelStockLevel[]): Promise<void>

  publishPrices(prices: readonly ChannelPrice[]): Promise<void>

  /** Orders placed since `since`, oldest first. */
  fetchOrders(since: Date): Promise<readonly ChannelOrder[]>

  publishOrderStatus(update: ChannelOrderStatusUpdate): Promise<void>

  /** The channel's own view of stock, for reconciliation. */
  fetchStock?(): Promise<readonly ChannelStockReport[]>

  /** Called once at startup. A failure here marks the channel unavailable. */
  connect?(): Promise<void>

  close?(): Promise<void>
}

export class ChannelError extends Error {
  override readonly name = 'ChannelError'
  constructor(
    readonly channelId: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`[${channelId}] ${message}`)
  }
}

/** Capabilities of a channel that can do nothing beyond the minimum. */
export const MINIMAL_CAPABILITIES: ChannelCapabilities = {
  customerGroups: false,
  priceLists: false,
  stockLevels: false,
  orderStatus: false,
  stockReporting: false,
}
