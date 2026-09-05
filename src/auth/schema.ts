import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/*
 * Identity lives in the tenant's own database.
 *
 * A shared identity store would need a second database in every self-hosted
 * installation and would put every customer's credentials behind one mistake.
 * Keeping it per tenant also settles access by construction: a session issued
 * for one tenant is meaningless to another, because the account does not exist
 * there.
 *
 * The `auth_*` tables are owned by the authentication library; `staff_*` tables
 * are the ERP's own view of a person.
 */

export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  /** Set by the library when a second factor is enrolled. */
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_sessions_user_idx').on(table.userId)],
)

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    /** Scopes an account's identity to the provider that issued it. */
    issuer: text('issuer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_accounts_user_idx').on(table.userId)],
)

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_verifications_identifier_idx').on(table.identifier)],
)

/** Signing keys for the tokens the API verifies without touching the database. */
export const authJwks = pgTable('auth_jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set when a key is rotated, so old tokens can still be verified. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  alg: text('alg'),
  crv: text('crv'),
})

export const authTwoFactors = pgTable(
  'auth_two_factors',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    verified: boolean('verified').default(true),
    /** Counted so a second factor cannot be brute-forced. */
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (table) => [index('auth_two_factors_user_idx').on(table.userId)],
)

/** A role is a named set of permissions. System roles ship with the product. */
export const staffRoles = pgTable('staff_roles', {
  name: text('name').primaryKey(),
  description: text('description'),
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
  isSystem: boolean('is_system').notNull().default(false),
  /**
   * Whether holders of this role must have a second factor.
   *
   * Set per role rather than per tenant: the people who can move money are
   * worth protecting more strongly than the people who read a stock list, and
   * forcing it on everyone is how it ends up switched off for everyone.
   */
  requiresTwoFactor: boolean('requires_two_factor').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The ERP's view of a person: which roles they hold and whether they still
 * work here. Kept apart from the credential record so that deactivating
 * someone is one decision in one place.
 */
export const staffMembers = pgTable(
  'staff_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authUserId: text('auth_user_id')
      .notNull()
      .unique()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    email: text('email').notNull(),
    roles: jsonb('roles').$type<string[]>().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('staff_members_active_idx').on(table.isActive)],
)

/** Single-use, expiring invitation. There is no self-registration for staff. */
export const staffInvitations = pgTable(
  'staff_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** Hash of the invitation token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    roles: jsonb('roles').$type<string[]>().notNull().default([]),
    invitedBy: text('invited_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('staff_invitations_email_idx').on(table.email)],
)

/**
 * Credentials for an integration.
 *
 * Never a person's credentials: an integration that signs in as a human is
 * indistinguishable from that human in the audit log, and cannot be revoked
 * without locking them out.
 */
export const serviceAccounts = pgTable(
  'service_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Public prefix of the key, shown in listings so a key can be recognised. */
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('service_accounts_prefix_key').on(table.keyPrefix)],
)

/** Append-only record of everything that changes who can do what. */
export const securityEvents = pgTable(
  'security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `sign_in.succeeded`, `role.granted`, `service_account.revoked`, ... */
    kind: text('kind').notNull(),
    actorType: text('actor_type'),
    actorId: text('actor_id'),
    /** Who or what the event is about. */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('security_events_occurred_idx').on(table.occurredAt),
    index('security_events_subject_idx').on(table.subjectType, table.subjectId),
    index('security_events_kind_idx').on(table.kind),
  ],
)

/** Failed sign-in attempts, for rate limiting and for the audit trail. */
export const signInAttempts = pgTable(
  'sign_in_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    succeeded: boolean('succeeded').notNull(),
    ipAddress: text('ip_address'),
    attempts: integer('attempts').notNull().default(1),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sign_in_attempts_email_idx').on(table.email, table.occurredAt)],
)

export type AuthUserRow = typeof authUsers.$inferSelect
export type StaffMemberRow = typeof staffMembers.$inferSelect
export type StaffRoleRow = typeof staffRoles.$inferSelect
export type StaffInvitationRow = typeof staffInvitations.$inferSelect
export type ServiceAccountRow = typeof serviceAccounts.$inferSelect
export type SecurityEventRow = typeof securityEvents.$inferSelect
