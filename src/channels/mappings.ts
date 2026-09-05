import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { channelMappings } from './schema.js'

export type MappedEntity = 'product' | 'variant' | 'customer' | 'order'

/**
 * Remembers what each thing is called on the other side.
 *
 * The mapping is what makes projection idempotent: with it, publishing the same
 * product again updates the listing; without it, every retry creates another
 * one, and the shop fills with duplicates nobody ordered.
 */
export class ChannelMappings {
  constructor(private readonly db: Database) {}

  async externalIdFor(channel: string, entityType: MappedEntity, localId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ externalId: channelMappings.externalId })
      .from(channelMappings)
      .where(
        and(
          eq(channelMappings.channel, channel),
          eq(channelMappings.entityType, entityType),
          eq(channelMappings.localId, localId),
        ),
      )
      .limit(1)
    return row?.externalId ?? null
  }

  async localIdFor(channel: string, entityType: MappedEntity, externalId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ localId: channelMappings.localId })
      .from(channelMappings)
      .where(
        and(
          eq(channelMappings.channel, channel),
          eq(channelMappings.entityType, entityType),
          eq(channelMappings.externalId, externalId),
        ),
      )
      .limit(1)
    return row?.localId ?? null
  }

  /** Records or updates one mapping. */
  async link(channel: string, entityType: MappedEntity, localId: string, externalId: string): Promise<void> {
    await this.db
      .insert(channelMappings)
      .values({ channel, entityType, localId, externalId })
      .onConflictDoUpdate({
        target: [channelMappings.channel, channelMappings.entityType, channelMappings.localId],
        set: { externalId, updatedAt: new Date() },
      })
  }

  async linkMany(
    channel: string,
    entityType: MappedEntity,
    pairs: readonly { localId: string; externalId: string }[],
  ): Promise<void> {
    for (const pair of pairs) await this.link(channel, entityType, pair.localId, pair.externalId)
  }

  /** Local ids for several external ids at once, for order intake. */
  async localIdsFor(
    channel: string,
    entityType: MappedEntity,
    externalIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map()
    const rows = await this.db
      .select({ localId: channelMappings.localId, externalId: channelMappings.externalId })
      .from(channelMappings)
      .where(
        and(
          eq(channelMappings.channel, channel),
          eq(channelMappings.entityType, entityType),
          inArray(channelMappings.externalId, [...externalIds]),
        ),
      )
    return new Map(rows.map((row) => [row.externalId, row.localId]))
  }

  async unlink(channel: string, entityType: MappedEntity, localId: string): Promise<void> {
    await this.db
      .delete(channelMappings)
      .where(
        and(
          eq(channelMappings.channel, channel),
          eq(channelMappings.entityType, entityType),
          eq(channelMappings.localId, localId),
        ),
      )
  }
}
