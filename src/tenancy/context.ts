import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from '../db/client.js'
import type { TenantRecord } from './tenant.js'

/** Who is performing the current operation. Recorded on every document. */
export interface Actor {
  readonly type: 'human' | 'integration' | 'bot'
  /** Staff account id, service account id, or bot id. */
  readonly id: string
  readonly displayName?: string
  /** For bots: the conversation this action belongs to. */
  readonly conversationId?: string
}

/** Everything an operation needs to know about where and for whom it runs. */
export interface TenantScope {
  readonly tenant: TenantRecord
  readonly db: Database
  readonly actor: Actor | null
}

export class MissingTenantContextError extends Error {
  override readonly name = 'MissingTenantContextError'
  constructor(what: string) {
    super(
      `${what} was requested outside a tenant context. Every request and every job must be ` +
        'started with runInTenantScope so the correct database is used.',
    )
  }
}

/**
 * Holds the current tenant for the duration of a request or job.
 *
 * The storage itself is module-level; what it carries is not. That distinction
 * is the whole point: a process-wide database handle would silently bind the
 * product to one customer, and finding every such handle later - after hundreds
 * of services import it directly - is the work that makes going multi-tenant
 * expensive. Here there is nothing to find.
 */
const storage = new AsyncLocalStorage<TenantScope>()

/** Runs `fn` with `scope` bound. Nested calls replace the scope for their subtree. */
export function runInTenantScope<T>(scope: TenantScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn)
}

/**
 * Binds `scope` for a synchronous call and everything it starts.
 *
 * Needed by frameworks whose hook chain continues through a callback: calling
 * the continuation inside the storage keeps the whole request in scope.
 */
export function bindTenantScope<T>(scope: TenantScope, fn: () => T): T {
  return storage.run(scope, fn)
}

/** The current scope, or `null` outside any. */
export function tryCurrentScope(): TenantScope | null {
  return storage.getStore() ?? null
}

export function currentScope(): TenantScope {
  const scope = storage.getStore()
  if (scope === undefined) throw new MissingTenantContextError('The tenant scope')
  return scope
}

export function currentTenant(): TenantRecord {
  return currentScope().tenant
}

/** The current tenant's database. Throws rather than fall back to a default. */
export function currentDb(): Database {
  const scope = storage.getStore()
  if (scope === undefined) throw new MissingTenantContextError('A database connection')
  return scope.db
}

export function currentActor(): Actor | null {
  return currentScope().actor
}

/**
 * The actor, insisting there is one.
 *
 * Core rule: every document records who produced it. A document written with
 * no actor is a document nobody can be asked about, so the modules that write
 * them use this rather than tolerating null.
 */
export function requireActor(what: string): Actor {
  const actor = currentScope().actor
  if (actor === null) throw new MissingActorError(what)
  return actor
}

export class MissingActorError extends Error {
  override readonly name = 'MissingActorError'
  constructor(readonly what: string) {
    super(`${what} cannot be recorded without an actor`)
  }
}

/** Runs `fn` with a different actor in the same tenant. */
export function withActor<T>(actor: Actor | null, fn: () => Promise<T>): Promise<T> {
  return runInTenantScope({ ...currentScope(), actor }, fn)
}
