import { FeedConsumer } from '../change-feed/feed.js'
import type { ChangeEvent } from '../change-feed/types.js'
import type { Database } from '../db/client.js'
import type { ChannelProductInput, SalesChannelAdapter } from './contract.js'
import { ChannelMappings } from './mappings.js'
import { ChannelOutbound, type OutboundItem } from './outbound.js'
import { ChannelPublications, decidePublication } from './publications.js'
import type { StockSource } from './stock.js'
import { ChannelStock } from './stock.js'

/**
 * Where the channel layer reads the catalog.
 *
 * A port, because the catalog belongs to another capability. The channel layer
 * must never grow its own copy of what a product is - two answers to that
 * question is how a shop ends up showing a price nobody set.
 */
export interface CatalogSource {
  /** The product as a channel should see it, or `null` if it is gone. */
  productFor(productLocalId: string): Promise<ChannelProductInput | null>
  /** Which product a variant belongs to. */
  productIdForVariant(variantLocalId: string): Promise<string | null>
}

export interface ChannelSyncOptions {
  readonly catalog: CatalogSource
  readonly stock?: StockSource
}

/** What the journal said, translated into work owed to a channel. */
export interface SyncResult {
  readonly delivered: number
  readonly queued: number
  readonly skipped: number
}

/**
 * Turns changes in the core into work for one channel.
 *
 * The journal is the only input: the core never calls a channel while saving,
 * so a slow or broken shop cannot make a stock receipt fail. What each channel
 * has caught up with is its own cursor, so one channel being down does not hold
 * back the others - or the marketplace feeds, or the search index.
 */
export class ChannelSync {
  private readonly consumer: FeedConsumer
  private readonly mappings: ChannelMappings
  private readonly publications: ChannelPublications
  private readonly outbound: ChannelOutbound
  private readonly stock: ChannelStock | null

  constructor(
    db: Database,
    private readonly channel: string,
    private readonly options: ChannelSyncOptions,
  ) {
    this.consumer = new FeedConsumer(db, `channel:${channel}`)
    this.mappings = new ChannelMappings(db)
    this.publications = new ChannelPublications(db)
    this.outbound = new ChannelOutbound(db)
    this.stock = options.stock === undefined ? null : new ChannelStock(db, options.stock)
  }

  get consumerName(): string {
    return `channel:${this.channel}`
  }

  async register(): Promise<void> {
    await this.consumer.register()
  }

  /** Reads the journal and queues whatever this channel now owes. */
  async pull(): Promise<SyncResult> {
    let queued = 0
    let skipped = 0

    const result = await this.consumer.drain(async (event) => {
      const handled = await this.translate(event)
      if (handled) queued += 1
      else skipped += 1
    })

    return { delivered: result.delivered, queued, skipped }
  }

  private async translate(event: ChangeEvent): Promise<boolean> {
    switch (event.entityType) {
      case 'product':
        return this.onProductChanged(event)
      case 'variant':
        return this.onVariantChanged(event)
      case 'stock':
        return this.onStockChanged(event.entityId)
      default:
        // Not everything in the journal concerns a shop: ledger entries and
        // staff changes pass through untouched.
        return false
    }
  }

  private async onProductChanged(event: ChangeEvent): Promise<boolean> {
    if (event.kind === 'deleted') {
      const externalId = await this.mappings.externalIdFor(this.channel, 'product', event.entityId)
      if (externalId === null) return false
      await this.outbound.enqueue(this.channel, 'unpublish', event.entityId, { externalId })
      return true
    }

    const product = await this.options.catalog.productFor(event.entityId)
    if (product === null) return false

    await this.outbound.enqueue(this.channel, 'product', event.entityId, {
      productLocalId: event.entityId,
    })
    return true
  }

  private async onVariantChanged(event: ChangeEvent): Promise<boolean> {
    const productId = await this.options.catalog.productIdForVariant(event.entityId)
    if (productId === null) return false
    await this.outbound.enqueue(this.channel, 'product', productId, { productLocalId: productId })
    return true
  }

  private async onStockChanged(variantLocalId: string): Promise<boolean> {
    if (this.stock === null) return false
    await this.stock.publish(this.channel, [variantLocalId])
    return true
  }

  /**
   * Sends what is queued.
   *
   * The decision to withhold a product is taken here rather than when queueing:
   * a channel's capabilities can change, and a product held back yesterday for
   * a channel that could not enforce customer groups should go out today if it
   * can.
   */
  async push(adapter: SalesChannelAdapter): Promise<{ sent: number; failed: number }> {
    const result = await this.outbound.dispatch(this.channel, async (item) => {
      await this.send(adapter, item)
    })
    return { sent: result.sent, failed: result.failed }
  }

  private async send(adapter: SalesChannelAdapter, item: OutboundItem): Promise<void> {
    switch (item.kind) {
      case 'product': {
        const localId = String(item.payload['productLocalId'] ?? item.subject)
        const product = await this.options.catalog.productFor(localId)
        if (product === null) return

        const decision = decidePublication(product, adapter.capabilities)
        if (!decision.publish) {
          const known = await this.mappings.externalIdFor(this.channel, 'product', localId)
          // Already listed and no longer allowed: take it down rather than
          // leave a wholesale price on public display.
          if (known !== null) {
            await adapter.unpublishProduct(known)
            await this.mappings.unlink(this.channel, 'product', localId)
          }
          return
        }

        const existing = await this.mappings.externalIdFor(this.channel, 'product', localId)
        const published = await adapter.publishProduct(product, existing ?? undefined)
        await this.mappings.link(this.channel, 'product', localId, published.externalId)
        await this.mappings.linkMany(this.channel, 'variant', [...published.variants])
        return
      }

      case 'unpublish': {
        await adapter.unpublishProduct(String(item.payload['externalId'] ?? ''))
        await this.mappings.unlink(this.channel, 'product', item.subject)
        return
      }

      case 'stock': {
        const level = item.payload as unknown as { variantLocalId: string; available: number }
        await adapter.publishStock([level])
        return
      }

      case 'price': {
        await adapter.publishPrices([item.payload as never])
        return
      }

      case 'order_status': {
        await adapter.publishOrderStatus(item.payload as never)
        return
      }
    }
  }

  /** Re-sends everything listed on this channel, ignoring what it thinks it knows. */
  async reproject(): Promise<number> {
    const listed = await this.publications.listedVariants(this.channel)
    const productIds = new Set<string>()

    for (const variantLocalId of listed) {
      const productId = await this.options.catalog.productIdForVariant(variantLocalId)
      if (productId !== null) productIds.add(productId)
    }

    for (const productId of productIds) {
      await this.outbound.enqueue(this.channel, 'product', productId, { productLocalId: productId })
    }
    return productIds.size
  }
}
