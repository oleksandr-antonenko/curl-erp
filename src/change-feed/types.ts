import type { Database } from '../db/client.js'
import type { Actor } from '../tenancy/context.js'

export const CHANGE_KINDS = ['created', 'updated', 'deleted'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

/** A Drizzle handle that may be the database or an open transaction. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

export interface ChangeEvent {
  /** Monotonic within the tenant; a consumer's cursor points at one of these. */
  readonly sequence: number
  readonly entityType: string
  readonly entityId: string
  readonly kind: ChangeKind
  readonly occurredAt: Date
  readonly actor: Actor | null
  /** Names of the fields that changed - never their values. */
  readonly changedFields: readonly string[] | null
}

export interface ChangeEventInput {
  readonly entityType: string
  readonly entityId: string
  readonly kind: ChangeKind
  readonly changedFields?: readonly string[]
  /** Defaults to the actor of the current tenant scope. */
  readonly actor?: Actor | null
  readonly occurredAt?: Date
}
