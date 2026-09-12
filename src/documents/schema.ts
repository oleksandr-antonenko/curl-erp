import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/*
 * The paper behind a number.
 *
 * A sum in the books is only as good as the thing it can be traced back to, so
 * a document is stored once, addressed by the hash of its content, and never
 * altered afterwards. Two uploads of the same invoice are the same document:
 * the hash says so, and a second copy of the bytes would only create a second
 * thing to keep in step.
 *
 * There is deliberately no delete here. Removing evidence is not an editing
 * operation, and a capability that offers it as one will eventually remove the
 * evidence for a number that is still in the accounts.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the content, lowercase hex. The document's identity. */
    contentHash: text('content_hash').notNull(),
    mediaType: text('media_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    /** Where the bytes live, as the configured store understands it. */
    location: text('location').notNull(),
    /** What a person called it, for reading later. Not an identifier. */
    fileName: text('file_name'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    actorConversationId: text('actor_conversation_id'),
    storedAt: timestamp('stored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('documents_content_hash_key').on(table.contentHash),
    index('documents_stored_at_idx').on(table.storedAt),
  ],
)

export type DocumentRow = typeof documents.$inferSelect
