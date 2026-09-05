import { and, eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import type { ChannelCapabilities, ChannelProductInput } from './contract.js'
import { channelPublications } from './schema.js'

export interface PublicationRule {
  readonly channel: string
  readonly variantLocalId: string
  readonly listed: boolean
  readonly priceShown: boolean
  readonly orderable: boolean
  readonly priceList: string | null
  readonly stockBuffer: number
}

export interface PublicationDecision {
  readonly publish: boolean
  /** Why a product is withheld, for the operator who wonders where it went. */
  readonly reason?: string
}

const DEFAULT_RULE = {
  listed: true,
  priceShown: true,
  orderable: true,
  priceList: null,
  stockBuffer: 0,
} as const

/**
 * Whether a product may be shown on a channel, and on what terms.
 *
 * The decisive rule is the group restriction: a professional-only line has a
 * price for salons and no retail price at all, and a channel that cannot
 * restrict by customer group would show it to everyone. Withholding it is the
 * only safe answer - a listing that leaks a wholesale price is not a display
 * bug, it is a price list handed to every competitor.
 */
export function decidePublication(
  product: Pick<ChannelProductInput, 'restrictedToGroups'>,
  capabilities: ChannelCapabilities,
): PublicationDecision {
  const restricted = product.restrictedToGroups ?? []
  if (restricted.length === 0) return { publish: true }
  if (capabilities.customerGroups) return { publish: true }
  return {
    publish: false,
    reason: `restricted to ${restricted.join(', ')}, and this channel cannot enforce customer groups`,
  }
}

export class ChannelPublications {
  constructor(private readonly db: Database) {}

  async ruleFor(channel: string, variantLocalId: string): Promise<PublicationRule> {
    const [row] = await this.db
      .select()
      .from(channelPublications)
      .where(
        and(eq(channelPublications.channel, channel), eq(channelPublications.variantLocalId, variantLocalId)),
      )
      .limit(1)

    if (row === undefined) return { channel, variantLocalId, ...DEFAULT_RULE }
    return {
      channel: row.channel,
      variantLocalId: row.variantLocalId,
      listed: row.listed,
      priceShown: row.priceShown,
      orderable: row.orderable,
      priceList: row.priceList,
      stockBuffer: row.stockBuffer,
    }
  }

  async set(
    channel: string,
    variantLocalId: string,
    changes: Partial<Omit<PublicationRule, 'channel' | 'variantLocalId'>>,
  ): Promise<PublicationRule> {
    const current = await this.ruleFor(channel, variantLocalId)
    const next = { ...current, ...changes }

    await this.db
      .insert(channelPublications)
      .values({
        channel,
        variantLocalId,
        listed: next.listed,
        priceShown: next.priceShown,
        orderable: next.orderable,
        priceList: next.priceList,
        stockBuffer: next.stockBuffer,
      })
      .onConflictDoUpdate({
        target: [channelPublications.channel, channelPublications.variantLocalId],
        set: {
          listed: next.listed,
          priceShown: next.priceShown,
          orderable: next.orderable,
          priceList: next.priceList,
          stockBuffer: next.stockBuffer,
          updatedAt: new Date(),
        },
      })

    return next
  }

  async listedVariants(channel: string): Promise<string[]> {
    const rows = await this.db
      .select({ variantLocalId: channelPublications.variantLocalId })
      .from(channelPublications)
      .where(and(eq(channelPublications.channel, channel), eq(channelPublications.listed, true)))
    return rows.map((row) => row.variantLocalId)
  }
}
