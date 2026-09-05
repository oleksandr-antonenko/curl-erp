import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import type { ChannelStockLevel, SalesChannelAdapter } from './contract.js'
import { ChannelMappings } from './mappings.js'
import { ChannelOutbound } from './outbound.js'
import { ChannelPublications } from './publications.js'
import { channelDrift } from './schema.js'

/**
 * Where available quantities come from.
 *
 * A port rather than a table: stock is owned by the inventory capability, and
 * the channel layer must not grow its own idea of what is in the warehouse.
 */
export interface StockSource {
  availableFor(variantLocalIds: readonly string[]): Promise<Map<string, number>>
}

export interface DriftEntry {
  readonly id: string
  readonly kind: string
  readonly subject: string
  readonly expected: string | null
  readonly actual: string | null
  readonly detectedAt: Date
}

export interface ReconciliationResult {
  readonly checked: number
  readonly corrected: number
  readonly drift: readonly DriftEntry[]
}

/**
 * Publishes stock outward and puts the channel back in line when it drifts.
 *
 * The core is the only place that knows what is really in the warehouse. A
 * buffer can be held back per channel, because propagation takes time and the
 * last unit is the one two channels sell at once.
 */
export class ChannelStock {
  private readonly mappings: ChannelMappings
  private readonly publications: ChannelPublications
  private readonly outbound: ChannelOutbound

  constructor(
    private readonly db: Database,
    private readonly source: StockSource,
  ) {
    this.mappings = new ChannelMappings(db)
    this.publications = new ChannelPublications(db)
    this.outbound = new ChannelOutbound(db)
  }

  /** What a channel should show for these variants, after buffers. */
  async levelsFor(channel: string, variantLocalIds: readonly string[]): Promise<ChannelStockLevel[]> {
    const actual = await this.source.availableFor(variantLocalIds)
    const levels: ChannelStockLevel[] = []

    for (const variantLocalId of variantLocalIds) {
      const rule = await this.publications.ruleFor(channel, variantLocalId)
      const available = actual.get(variantLocalId) ?? 0
      levels.push({
        variantLocalId,
        // Never negative: a channel shown -3 either refuses the update or shows
        // it to a customer.
        available: rule.orderable ? Math.max(0, available - rule.stockBuffer) : 0,
      })
    }
    return levels
  }

  /** Queues a stock update. Queued rather than sent, so an outage cannot block. */
  async publish(channel: string, variantLocalIds: readonly string[]): Promise<void> {
    for (const level of await this.levelsFor(channel, variantLocalIds)) {
      await this.outbound.enqueue(channel, 'stock', level.variantLocalId, { ...level })
    }
  }

  /**
   * Compares the channel's own numbers with ours and corrects it.
   *
   * Drift is not hypothetical: a manual edit in the channel, a failed update or
   * a partial outage all produce it, and the first symptom is usually selling
   * something that is not there.
   */
  async reconcile(channel: string, adapter: SalesChannelAdapter): Promise<ReconciliationResult> {
    if (adapter.fetchStock === undefined) {
      return { checked: 0, corrected: 0, drift: [] }
    }

    const reported = await adapter.fetchStock()
    const localIds = await this.mappings.localIdsFor(
      channel,
      'variant',
      reported.map((entry) => entry.externalVariantId),
    )

    const known = reported.flatMap((entry) => {
      const localId = localIds.get(entry.externalVariantId)
      return localId === undefined ? [] : [{ localId, reported: entry.available }]
    })

    const expected = new Map(
      (
        await this.levelsFor(
          channel,
          known.map((entry) => entry.localId),
        )
      ).map((level) => [level.variantLocalId, level.available]),
    )

    const corrections: ChannelStockLevel[] = []
    const recorded: DriftEntry[] = []

    for (const entry of known) {
      const shouldBe = expected.get(entry.localId) ?? 0
      if (shouldBe === entry.reported) continue

      corrections.push({ variantLocalId: entry.localId, available: shouldBe })
      const [row] = await this.db
        .insert(channelDrift)
        .values({
          channel,
          kind: 'stock',
          subject: entry.localId,
          expected: String(shouldBe),
          actual: String(entry.reported),
        })
        .returning()
      if (row !== undefined) {
        recorded.push({
          id: row.id,
          kind: row.kind,
          subject: row.subject,
          expected: row.expected,
          actual: row.actual,
          detectedAt: row.detectedAt,
        })
      }
    }

    if (corrections.length > 0) await adapter.publishStock(corrections)

    return { checked: known.length, corrected: corrections.length, drift: recorded }
  }

  /** Divergences not yet dealt with. */
  async openDrift(channel: string): Promise<DriftEntry[]> {
    const rows = await this.db
      .select()
      .from(channelDrift)
      .where(and(eq(channelDrift.channel, channel), isNull(channelDrift.resolvedAt)))
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      expected: row.expected,
      actual: row.actual,
      detectedAt: row.detectedAt,
    }))
  }

  async resolveDrift(channel: string): Promise<number> {
    const rows = await this.db
      .update(channelDrift)
      .set({ resolvedAt: new Date() })
      .where(and(eq(channelDrift.channel, channel), isNull(channelDrift.resolvedAt)))
      .returning({ id: channelDrift.id })
    return rows.length
  }
}
