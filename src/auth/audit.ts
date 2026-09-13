import { and, desc, eq, gte, lte } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import type { Principal } from './principal.js'
import { securityEvents } from './schema.js'

/** Events that change who can do what, plus the attempts to sign in. */
export const SECURITY_EVENT_KINDS = [
  'sign_in.succeeded',
  'sign_in.failed',
  'sign_out',
  'password.reset_requested',
  'password.reset_completed',
  'two_factor.enabled',
  'two_factor.disabled',
  'invitation.created',
  'invitation.accepted',
  'invitation.revoked',
  /* A burst of invitations from one account, refused. Worth a record whether
   * or not it got through: the interesting case is the account that keeps
   * trying. */
  'invitation.throttled',
  'role.created',
  'role.updated',
  'role.deleted',
  'staff.roles_changed',
  'staff.deactivated',
  'staff.reactivated',
  'service_account.created',
  'service_account.revoked',
  'session.revoked',
  'audit.tamper_attempt',
] as const

export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number]

export interface SecurityEventInput {
  readonly kind: SecurityEventKind
  readonly actor?: Pick<Principal, 'kind' | 'id'> | null
  readonly subjectType?: string
  readonly subjectId?: string
  readonly ipAddress?: string
  readonly userAgent?: string
  readonly detail?: Record<string, unknown>
}

export interface SecurityEvent {
  readonly id: string
  readonly kind: SecurityEventKind
  readonly actorType: string | null
  readonly actorId: string | null
  readonly subjectType: string | null
  readonly subjectId: string | null
  readonly ipAddress: string | null
  readonly userAgent: string | null
  readonly detail: Record<string, unknown> | null
  readonly occurredAt: Date
}

export interface AuditFilter {
  readonly kind?: SecurityEventKind
  readonly subjectId?: string
  readonly from?: Date
  readonly to?: Date
  readonly limit?: number
}

export class AuditTamperError extends Error {
  override readonly name = 'AuditTamperError'
}

/**
 * The record of who was given what, and who tried to sign in.
 *
 * Append-only in the application and enforced again by the database: an audit
 * log that the application can rewrite proves nothing about the application.
 */
export class SecurityAudit {
  constructor(private readonly db: Database) {}

  async record(input: SecurityEventInput): Promise<void> {
    await this.db.insert(securityEvents).values({
      kind: input.kind,
      actorType: input.actor?.kind ?? null,
      actorId: input.actor?.id ?? null,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      detail: input.detail ?? null,
    })
  }

  async list(filter: AuditFilter = {}): Promise<SecurityEvent[]> {
    const conditions = [
      filter.kind === undefined ? undefined : eq(securityEvents.kind, filter.kind),
      filter.subjectId === undefined ? undefined : eq(securityEvents.subjectId, filter.subjectId),
      filter.from === undefined ? undefined : gte(securityEvents.occurredAt, filter.from),
      filter.to === undefined ? undefined : lte(securityEvents.occurredAt, filter.to),
    ].filter((condition) => condition !== undefined)

    const rows = await this.db
      .select()
      .from(securityEvents)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(securityEvents.occurredAt))
      .limit(filter.limit ?? 200)

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as SecurityEventKind,
      actorType: row.actorType,
      actorId: row.actorId,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      detail: row.detail,
      occurredAt: row.occurredAt,
    }))
  }

  /**
   * Refuses to alter the log, and records the attempt.
   *
   * The database refuses too. This exists so the refusal leaves a trace: a
   * database error rolls back, taking any note of it with it.
   */
  async refuseTamper(actor: Pick<Principal, 'kind' | 'id'> | null, what: string): Promise<never> {
    await this.record({
      kind: 'audit.tamper_attempt',
      ...(actor === null ? {} : { actor }),
      detail: { attempted: what },
    })
    throw new AuditTamperError(`The audit log is append-only; ${what} was refused and recorded.`)
  }
}
