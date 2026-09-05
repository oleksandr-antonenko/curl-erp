import type { Database } from '../db/client.js'
import { type Actor, tryCurrentScope } from '../tenancy/context.js'
import { type ChangeEventRow, changeEvents } from './schema.js'
import type { ChangeEvent, ChangeEventInput, ChangeKind, Executor } from './types.js'

export function toChangeEvent(row: ChangeEventRow): ChangeEvent {
  const actor: Actor | null =
    row.actorType === null || row.actorId === null
      ? null
      : {
          type: row.actorType as Actor['type'],
          id: row.actorId,
          ...(row.actorConversationId === null ? {} : { conversationId: row.actorConversationId }),
        }

  return {
    sequence: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    kind: row.kind as ChangeKind,
    occurredAt: row.occurredAt,
    actor,
    changedFields: row.changedFields ?? null,
  }
}

/**
 * Writes one journal event.
 *
 * Takes the executor rather than opening its own transaction, so the event is
 * written by the same transaction as the change it describes. That is what
 * makes the journal trustworthy: a rolled-back change leaves no event, and a
 * committed change cannot fail to produce one.
 */
export async function recordChange(executor: Executor, input: ChangeEventInput): Promise<ChangeEvent> {
  const [row] = await recordChanges(executor, [input])
  if (row === undefined) throw new Error('Failed to record change event')
  return row
}

export async function recordChanges(
  executor: Executor,
  inputs: readonly ChangeEventInput[],
): Promise<ChangeEvent[]> {
  if (inputs.length === 0) return []

  const ambientActor = tryCurrentScope()?.actor ?? null
  const values = inputs.map((input) => {
    const actor = input.actor === undefined ? ambientActor : input.actor
    return {
      entityType: input.entityType,
      entityId: input.entityId,
      kind: input.kind,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      actorType: actor?.type ?? null,
      actorId: actor?.id ?? null,
      actorConversationId: actor?.conversationId ?? null,
      changedFields: input.changedFields === undefined ? null : [...input.changedFields],
    }
  })

  const rows = await executor.insert(changeEvents).values(values).returning()
  return rows.map(toChangeEvent)
}

/** Records events collected during a transaction. */
export interface Journal {
  record(input: ChangeEventInput): void
}

/**
 * Runs `fn` in a transaction and writes whatever it journalled.
 *
 * Callers describe the change once and cannot forget the second half: there is
 * no path where the write commits and the event does not.
 */
export async function journaled<T>(
  db: Database,
  fn: (executor: Executor, journal: Journal) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const collected: ChangeEventInput[] = []
    const result = await fn(tx, {
      record(input) {
        collected.push(input)
      },
    })
    await recordChanges(tx, collected)
    return result
  })
}
