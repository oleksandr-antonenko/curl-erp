import { asc, count, eq } from 'drizzle-orm'
import { recordChange } from '../change-feed/record.js'
import type { Database } from '../db/client.js'
import { CatalogError } from './errors.js'
import { IMAGE_ORIGINS, type ImageOrigin, productImages } from './schema.js'

export interface ProductImage {
  readonly id: string
  readonly productId: string
  readonly variantId: string | null
  readonly url: string
  readonly alt: string | null
  readonly position: number
  readonly origin: ImageOrigin
  readonly originNote: string | null
}

export interface AddImageInput {
  readonly productId: string
  readonly url: string
  readonly origin: ImageOrigin
  readonly variantId?: string
  readonly alt?: string
  readonly position?: number
  readonly originNote?: string
  readonly legacyId?: string
}

/**
 * Pictures, each with a record of where it came from.
 *
 * A manufacturer's photograph, a competitor's, and something a model generated
 * are legally different, and a year later nothing recovers which was which. So
 * the origin is required at upload: one dropdown now against an unanswerable
 * question later.
 */
export class Images {
  constructor(private readonly db: Database) {}

  async add(input: AddImageInput): Promise<ProductImage> {
    if (!IMAGE_ORIGINS.includes(input.origin)) {
      throw new CatalogError(
        `Image origin must be one of: ${IMAGE_ORIGINS.join(', ')}. Received "${String(input.origin)}".`,
      )
    }
    if (input.origin === 'other' && (input.originNote ?? '').trim() === '') {
      throw new CatalogError('An image with origin "other" must say where it came from')
    }

    const position = input.position ?? (await this.nextPosition(input.productId))

    const [row] = await this.db
      .insert(productImages)
      .values({
        productId: input.productId,
        variantId: input.variantId ?? null,
        url: input.url,
        alt: input.alt ?? null,
        position,
        origin: input.origin,
        originNote: input.originNote ?? null,
        legacyId: input.legacyId ?? null,
      })
      .returning()
    if (row === undefined) throw new CatalogError('Failed to add image')

    await recordChange(this.db, {
      entityType: 'product',
      entityId: input.productId,
      kind: 'updated',
      changedFields: ['images'],
    })

    return toImage(row)
  }

  async of(productId: string): Promise<ProductImage[]> {
    return (
      await this.db
        .select()
        .from(productImages)
        .where(eq(productImages.productId, productId))
        .orderBy(asc(productImages.position))
    ).map(toImage)
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(productImages).where(eq(productImages.id, id))
  }

  /** How many images came from each source. Answers the rights question. */
  async countByOrigin(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ origin: productImages.origin, value: count() })
      .from(productImages)
      .groupBy(productImages.origin)
    return Object.fromEntries(rows.map((row) => [row.origin, row.value]))
  }

  private async nextPosition(productId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(productImages)
      .where(eq(productImages.productId, productId))
    return row?.value ?? 0
  }
}

function toImage(row: {
  id: string
  productId: string
  variantId: string | null
  url: string
  alt: string | null
  position: number
  origin: string
  originNote: string | null
}): ProductImage {
  return {
    id: row.id,
    productId: row.productId,
    variantId: row.variantId,
    url: row.url,
    alt: row.alt,
    position: row.position,
    origin: row.origin as ImageOrigin,
    originNote: row.originNote,
  }
}
