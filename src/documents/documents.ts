import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { requireActor } from '../tenancy/context.js'
import { type DocumentRow, documents } from './schema.js'
import type { DocumentStore } from './store.js'

export class DocumentError extends Error {
  override readonly name = 'DocumentError'
}

/** The stored bytes no longer hash to what was recorded when they arrived. */
export class IntegrityError extends DocumentError {
  constructor(
    readonly documentId: string,
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(`Document ${documentId} no longer matches its recorded hash`)
  }
}

export class DocumentNotFoundError extends DocumentError {
  constructor(readonly documentId: string) {
    super(`No document with id ${documentId}`)
  }
}

/** Something in the books points at this document, so it cannot go. */
export class DocumentInUseError extends DocumentError {
  constructor(
    readonly documentId: string,
    readonly heldBy: string,
  ) {
    super(`Document ${documentId} is referenced by ${heldBy}`)
  }
}

export interface StoreDocumentInput {
  readonly content: Uint8Array
  readonly mediaType: string
  readonly fileName?: string
}

export interface StoredDocument {
  readonly id: string
  readonly contentHash: string
  readonly mediaType: string
  readonly byteSize: number
  readonly fileName: string | null
  readonly storedAt: Date
  /** False when this content was already held and the existing row was reused. */
  readonly isNew: boolean
}

/** Anything that can say whether a document is still referenced. */
export interface DocumentReference {
  /** A phrase naming what holds it, or null when it holds nothing. */
  heldBy(db: Database, documentId: string): Promise<string | null>
}

/**
 * The evidence behind numbers in the books.
 *
 * Content-addressed: the same invoice uploaded twice is one document. That
 * keeps a second copy of the bytes from existing, and it means a receipt and
 * whatever else cites the same paper cite the same row.
 */
export class Documents {
  constructor(
    private readonly db: Database,
    private readonly store: DocumentStore,
    /** Consulted before a document may be removed. */
    private readonly references: readonly DocumentReference[] = [],
  ) {}

  /**
   * Stores content, or returns what is already held for it.
   *
   * The hash is computed before anything is written, so identical content never
   * reaches the store twice and the caller cannot tell the difference apart
   * from `isNew`.
   */
  async put(input: StoreDocumentInput): Promise<StoredDocument> {
    if (input.content.byteLength === 0) throw new DocumentError('An empty document is not evidence')
    const contentHash = hashOf(input.content)

    const [existing] = await this.db
      .select()
      .from(documents)
      .where(eq(documents.contentHash, contentHash))
      .limit(1)
    if (existing !== undefined) return { ...toDocument(existing), isNew: false }

    const actor = requireActor('A document')
    const location = await this.store.put({
      contentHash,
      content: input.content,
      mediaType: input.mediaType,
    })

    const [row] = await this.db
      .insert(documents)
      .values({
        contentHash,
        mediaType: input.mediaType,
        byteSize: input.content.byteLength,
        location,
        fileName: input.fileName ?? null,
        actorType: actor.type,
        actorId: actor.id,
        actorConversationId: actor.conversationId ?? null,
      })
      .returning()
    if (row === undefined) throw new DocumentError('Failed to record the document')
    return { ...toDocument(row), isNew: true }
  }

  async find(documentId: string): Promise<StoredDocument | null> {
    const [row] = await this.db.select().from(documents).where(eq(documents.id, documentId)).limit(1)
    return row === undefined ? null : { ...toDocument(row), isNew: false }
  }

  /**
   * Reads the content back, checking it is still what arrived.
   *
   * The check is the point of storing the hash: evidence that can be swapped
   * without anyone noticing is not evidence.
   */
  async read(documentId: string): Promise<Uint8Array> {
    const [row] = await this.db.select().from(documents).where(eq(documents.id, documentId)).limit(1)
    if (row === undefined) throw new DocumentNotFoundError(documentId)

    const content = await this.store.get(row.location)
    const actual = hashOf(content)
    if (actual !== row.contentHash) throw new IntegrityError(documentId, row.contentHash, actual)
    return content
  }

  /**
   * Removes a document, refusing while anything cites it.
   *
   * Deliberately not reachable from editing or cancelling a receipt: removing
   * evidence is its own decision, and a routine operation that happens to
   * delete it would eventually delete the paper behind a live number.
   */
  async remove(documentId: string): Promise<void> {
    const [row] = await this.db.select().from(documents).where(eq(documents.id, documentId)).limit(1)
    if (row === undefined) throw new DocumentNotFoundError(documentId)

    for (const reference of this.references) {
      const heldBy = await reference.heldBy(this.db, documentId)
      if (heldBy !== null) throw new DocumentInUseError(documentId, heldBy)
    }

    await this.db.delete(documents).where(eq(documents.id, documentId))
  }
}

function hashOf(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function toDocument(row: DocumentRow): Omit<StoredDocument, 'isNew'> {
  return {
    id: row.id,
    contentHash: row.contentHash,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    fileName: row.fileName,
    storedAt: row.storedAt,
  }
}
