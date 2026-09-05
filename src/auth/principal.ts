import type { Actor } from '../tenancy/context.js'
import type { Permission } from './permissions.js'

export type PrincipalKind = 'staff' | 'service' | 'bot'

/** Who is acting, and what they are allowed to do. */
export interface Principal {
  readonly kind: PrincipalKind
  /** Staff member id, service account id, or bot id. */
  readonly id: string
  readonly displayName: string
  /** Credential record behind a staff principal. Absent for integrations. */
  readonly authUserId?: string
  readonly roles: readonly string[]
  readonly permissions: ReadonlySet<Permission>
  /** For bots: the conversation this action belongs to. */
  readonly conversationId?: string
  /** Whether a second factor is enrolled on the account behind this principal. */
  readonly twoFactorEnabled?: boolean
  /** Whether any role this principal holds demands a second factor. */
  readonly requiresTwoFactor?: boolean
}

export class TwoFactorRequiredError extends Error {
  override readonly name = 'TwoFactorRequiredError'
  constructor(readonly principalId: string) {
    super('This account holds a role that requires a second factor, which is not enrolled')
  }
}

/** True when the principal holds a role demanding a second factor they lack. */
export function needsTwoFactorEnrolment(principal: Principal): boolean {
  return principal.requiresTwoFactor === true && principal.twoFactorEnabled !== true
}

export class AuthorizationError extends Error {
  override readonly name = 'AuthorizationError'
  constructor(
    readonly permission: Permission,
    readonly principalId: string,
  ) {
    super(`Not permitted: ${permission}`)
  }
}

export class AuthenticationError extends Error {
  override readonly name = 'AuthenticationError'
  constructor(message = 'Not authenticated') {
    super(message)
  }
}

export function can(principal: Principal, permission: Permission): boolean {
  return principal.permissions.has(permission)
}

export function canAll(principal: Principal, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => principal.permissions.has(permission))
}

/** Throws unless the principal holds the permission. */
export function authorize(principal: Principal, permission: Permission): void {
  if (!principal.permissions.has(permission)) {
    throw new AuthorizationError(permission, principal.id)
  }
}

/** The actor to record on documents this principal creates. */
export function actorOf(principal: Principal): Actor {
  const type: Actor['type'] =
    principal.kind === 'staff' ? 'human' : principal.kind === 'bot' ? 'bot' : 'integration'
  return {
    type,
    id: principal.id,
    displayName: principal.displayName,
    ...(principal.conversationId === undefined ? {} : { conversationId: principal.conversationId }),
  }
}

/**
 * Removes fields the principal may not see.
 *
 * Omits them rather than blanking them: a zero where a margin should be is
 * indistinguishable from a real zero, and someone will eventually make a
 * decision on it.
 */
export function redact<T extends Record<string, unknown>>(
  principal: Principal,
  value: T,
  gated: Partial<Record<keyof T, Permission>>,
): Partial<T> {
  const result: Partial<T> = {}
  for (const [key, fieldValue] of Object.entries(value) as [keyof T, T[keyof T]][]) {
    const required = gated[key]
    if (required !== undefined && !principal.permissions.has(required)) continue
    result[key] = fieldValue
  }
  return result
}

export function redactMany<T extends Record<string, unknown>>(
  principal: Principal,
  values: readonly T[],
  gated: Partial<Record<keyof T, Permission>>,
): Partial<T>[] {
  return values.map((value) => redact(principal, value, gated))
}
