import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, asc, count, desc, eq, gte, isNull } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { StaffDirectory, type StaffMember } from './directory.js'
import { staffInvitations } from './schema.js'

export class InvitationError extends Error {
  override readonly name = 'InvitationError'
}

/**
 * This address already has an invitation that can still be used.
 *
 * Issuing a second one is not harmless duplication: it puts two working tokens
 * into the world for one person, and then revoking "the invitation" revokes
 * one of them while the other still opens the door.
 */
export class DuplicateInvitationError extends InvitationError {
  constructor(
    readonly email: string,
    readonly existing: Invitation,
  ) {
    super(`${email} already has an invitation that is still valid`)
  }
}

export interface Invitation {
  readonly id: string
  readonly email: string
  readonly roles: readonly string[]
  readonly invitedBy: string | null
  readonly expiresAt: Date
  readonly acceptedAt: Date | null
  readonly revokedAt: Date | null
  readonly createdAt: Date
}

export interface IssuedInvitation {
  readonly invitation: Invitation
  /** Shown once, then unrecoverable: only its hash is stored. */
  readonly token: string
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Invitation-only onboarding.
 *
 * There is no self-registration for staff, because a system that holds a
 * company's books must not let anyone who can reach the login page create an
 * account in it. Tokens are single-use and expire so a forwarded email does not
 * stay a way in.
 */
export class StaffInvitations {
  private readonly directory: StaffDirectory

  constructor(
    private readonly db: Database,
    private readonly options: { readonly ttlMs?: number; readonly now?: () => Date } = {},
  ) {
    this.directory = new StaffDirectory(db)
  }

  private get clock(): () => Date {
    return this.options.now ?? ((): Date => new Date())
  }

  /**
   * Issues one invitation for an address, and refuses a second.
   *
   * The refusal is part of what an invitation is, not a policy of any one
   * application: a live invitation is a key to the building, and handing out
   * two keys while calling it one makes revocation a lie. A caller that means
   * to replace an invitation revokes the old one first, which is a decision
   * somebody makes rather than a side effect of pressing a button twice.
   */
  async invite(input: {
    email: string
    roles: readonly string[]
    invitedBy?: string
  }): Promise<IssuedInvitation> {
    const email = input.email.toLowerCase()
    const live = await this.liveFor(email)
    if (live !== null) throw new DuplicateInvitationError(email, live)

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(this.clock().getTime() + (this.options.ttlMs ?? DEFAULT_TTL_MS))

    const [row] = await this.db
      .insert(staffInvitations)
      .values({
        email,
        tokenHash: hashToken(token),
        roles: [...input.roles],
        invitedBy: input.invitedBy ?? null,
        expiresAt,
      })
      .returning()

    if (row === undefined) throw new InvitationError('Failed to create invitation')
    return { invitation: toInvitation(row), token }
  }

  /**
   * The invitation this address can still use, if any.
   *
   * "Still usable" is the same three conditions the token check applies:
   * not accepted, not revoked, not expired. An expired invitation is not in
   * the way of a new one.
   */
  async liveFor(email: string): Promise<Invitation | null> {
    const [row] = await this.db
      .select()
      .from(staffInvitations)
      .where(
        and(
          eq(staffInvitations.email, email.toLowerCase()),
          isNull(staffInvitations.acceptedAt),
          isNull(staffInvitations.revokedAt),
          gte(staffInvitations.expiresAt, this.clock()),
        ),
      )
      .orderBy(desc(staffInvitations.createdAt))
      .limit(1)
    return row === undefined ? null : toInvitation(row)
  }

  /**
   * How many invitations were issued since a moment, by whom or to whom.
   *
   * A fact, with no policy in it: how many is too many, and over what window,
   * is a decision each deployment makes, so the numbers live with the caller.
   * Counted from the table rather than from memory, so it survives a restart
   * and holds across however many processes serve the admin.
   */
  async countIssuedSince(input: {
    readonly since: Date
    readonly invitedBy?: string
    readonly email?: string
  }): Promise<number> {
    const conditions = [gte(staffInvitations.createdAt, input.since)]
    if (input.invitedBy !== undefined) {
      conditions.push(eq(staffInvitations.invitedBy, input.invitedBy))
    }
    if (input.email !== undefined) {
      conditions.push(eq(staffInvitations.email, input.email.toLowerCase()))
    }

    const [row] = await this.db
      .select({ issued: count() })
      .from(staffInvitations)
      .where(and(...conditions))
    return row?.issued ?? 0
  }

  /** The invitation a token refers to, if it can still be used. */
  async find(token: string): Promise<Invitation | null> {
    const [row] = await this.db
      .select()
      .from(staffInvitations)
      .where(eq(staffInvitations.tokenHash, hashToken(token)))
      .limit(1)
    return row === undefined ? null : toInvitation(row)
  }

  /**
   * Consumes an invitation and makes the account staff.
   *
   * The update is conditional on the invitation still being unused, so two
   * simultaneous attempts cannot both succeed.
   */
  async accept(
    token: string,
    account: { authUserId: string; displayName: string; email: string },
  ): Promise<StaffMember> {
    const now = this.clock()
    const [claimed] = await this.db
      .update(staffInvitations)
      .set({ acceptedAt: now })
      .where(
        and(
          eq(staffInvitations.tokenHash, hashToken(token)),
          isNull(staffInvitations.acceptedAt),
          isNull(staffInvitations.revokedAt),
        ),
      )
      .returning()

    if (claimed === undefined) {
      throw new InvitationError('This invitation has already been used, or does not exist')
    }
    if (claimed.expiresAt.getTime() < now.getTime()) {
      // Put it back so the record still shows it was never accepted.
      await this.db
        .update(staffInvitations)
        .set({ acceptedAt: null })
        .where(eq(staffInvitations.id, claimed.id))
      throw new InvitationError('This invitation has expired')
    }
    if (claimed.email !== account.email.toLowerCase()) {
      await this.db
        .update(staffInvitations)
        .set({ acceptedAt: null })
        .where(eq(staffInvitations.id, claimed.id))
      throw new InvitationError('This invitation was issued for a different address')
    }

    return this.directory.addMember({
      authUserId: account.authUserId,
      displayName: account.displayName,
      email: account.email,
      roles: claimed.roles,
    })
  }

  async revoke(id: string): Promise<void> {
    await this.db.update(staffInvitations).set({ revokedAt: this.clock() }).where(eq(staffInvitations.id, id))
  }

  async listPending(): Promise<Invitation[]> {
    const rows = await this.db
      .select()
      .from(staffInvitations)
      .where(and(isNull(staffInvitations.acceptedAt), isNull(staffInvitations.revokedAt)))
      .orderBy(desc(staffInvitations.createdAt))
    return rows.map(toInvitation)
  }

  async list(): Promise<Invitation[]> {
    const rows = await this.db.select().from(staffInvitations).orderBy(asc(staffInvitations.email))
    return rows.map(toInvitation)
  }

  /** Constant-time comparison for callers that hold a token to compare. */
  static tokensMatch(a: string, b: string): boolean {
    const left = Buffer.from(hashToken(a), 'hex')
    const right = Buffer.from(hashToken(b), 'hex')
    return timingSafeEqual(left, right)
  }
}

function toInvitation(row: {
  id: string
  email: string
  roles: string[]
  invitedBy: string | null
  expiresAt: Date
  acceptedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}): Invitation {
  return {
    id: row.id,
    email: row.email,
    roles: row.roles,
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  }
}
