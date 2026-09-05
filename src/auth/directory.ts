import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import {
  isPermission,
  type Permission,
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLES,
  type SystemRole,
} from './permissions.js'
import type { Principal } from './principal.js'
import { authSessions, authUsers, staffMembers, staffRoles } from './schema.js'

export interface RoleDefinition {
  readonly name: string
  readonly description: string | null
  readonly permissions: readonly Permission[]
  readonly isSystem: boolean
}

export interface StaffMember {
  readonly id: string
  readonly authUserId: string
  readonly displayName: string
  readonly email: string
  readonly roles: readonly string[]
  readonly isActive: boolean
}

export class RoleError extends Error {
  override readonly name = 'RoleError'
}

function onlyPermissions(values: readonly string[]): Permission[] {
  return values.filter(isPermission)
}

/**
 * Staff, roles and the permissions they add up to.
 *
 * Kept in the tenant's database rather than in a shared directory: who may post
 * to a company's books is that company's decision, and its list of people
 * belongs in its own backup.
 */
export class StaffDirectory {
  constructor(private readonly db: Database) {}

  /** Installs the roles that ship with the product. Safe to run repeatedly. */
  async ensureSystemRoles(): Promise<void> {
    for (const name of SYSTEM_ROLE_NAMES) {
      const permissions = [...SYSTEM_ROLES[name]]
      await this.db
        .insert(staffRoles)
        .values({ name, permissions, isSystem: true })
        .onConflictDoUpdate({
          target: staffRoles.name,
          // System roles follow the code: a release that adds a permission must
          // reach the people who already hold the role.
          set: { permissions, isSystem: true, updatedAt: new Date() },
        })
    }
  }

  async listRoles(): Promise<RoleDefinition[]> {
    const rows = await this.db.select().from(staffRoles).orderBy(asc(staffRoles.name))
    return rows.map((row) => ({
      name: row.name,
      description: row.description,
      permissions: onlyPermissions(row.permissions),
      isSystem: row.isSystem,
    }))
  }

  async createRole(
    name: string,
    permissions: readonly string[],
    description?: string,
  ): Promise<RoleDefinition> {
    const unknown = permissions.filter((permission) => !isPermission(permission))
    if (unknown.length > 0) {
      throw new RoleError(`Unknown permissions: ${unknown.join(', ')}`)
    }
    if (name in SYSTEM_ROLES) {
      throw new RoleError(`"${name}" is a system role and cannot be redefined`)
    }

    const [row] = await this.db
      .insert(staffRoles)
      .values({
        name,
        permissions: [...permissions],
        description: description ?? null,
        isSystem: false,
      })
      .onConflictDoUpdate({
        target: staffRoles.name,
        set: { permissions: [...permissions], description: description ?? null },
      })
      .returning()

    if (row === undefined) throw new RoleError(`Failed to save role "${name}"`)
    return {
      name: row.name,
      description: row.description,
      permissions: onlyPermissions(row.permissions),
      isSystem: row.isSystem,
    }
  }

  async deleteRole(name: string): Promise<void> {
    if (name in SYSTEM_ROLES) throw new RoleError(`"${name}" is a system role`)
    await this.db.delete(staffRoles).where(eq(staffRoles.name, name))
  }

  /** Permissions granted by a set of role names, ignoring roles that vanished. */
  async permissionsOf(roles: readonly string[]): Promise<Set<Permission>> {
    if (roles.length === 0) return new Set()
    const rows = await this.db
      .select({ permissions: staffRoles.permissions })
      .from(staffRoles)
      .where(inArray(staffRoles.name, [...roles]))

    const granted = new Set<Permission>()
    for (const row of rows) {
      for (const permission of onlyPermissions(row.permissions)) granted.add(permission)
    }
    return granted
  }

  async addMember(input: {
    authUserId: string
    displayName: string
    email: string
    roles: readonly string[]
  }): Promise<StaffMember> {
    const [row] = await this.db
      .insert(staffMembers)
      .values({
        authUserId: input.authUserId,
        displayName: input.displayName,
        email: input.email,
        roles: [...input.roles],
      })
      .onConflictDoUpdate({
        target: staffMembers.authUserId,
        set: { roles: [...input.roles], displayName: input.displayName, updatedAt: new Date() },
      })
      .returning()

    if (row === undefined) throw new RoleError('Failed to add staff member')
    return toMember(row)
  }

  async setRoles(authUserId: string, roles: readonly string[]): Promise<StaffMember> {
    const [row] = await this.db
      .update(staffMembers)
      .set({ roles: [...roles], updatedAt: new Date() })
      .where(eq(staffMembers.authUserId, authUserId))
      .returning()
    if (row === undefined) throw new RoleError(`No staff member for account ${authUserId}`)
    return toMember(row)
  }

  /**
   * Ends or restores someone's access.
   *
   * Deactivating also destroys their sessions: leaving a session alive would
   * mean a former employee keeps working until it expires on its own, and the
   * whole point of the switch is that it takes effect now.
   */
  async setActive(authUserId: string, isActive: boolean): Promise<StaffMember> {
    const [row] = await this.db
      .update(staffMembers)
      .set({
        isActive,
        deactivatedAt: isActive ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(staffMembers.authUserId, authUserId))
      .returning()
    if (row === undefined) throw new RoleError(`No staff member for account ${authUserId}`)

    if (!isActive) await this.revokeSessions(authUserId)
    return toMember(row)
  }

  /** Destroys every session of an account. Returns how many were ended. */
  async revokeSessions(authUserId: string): Promise<number> {
    const removed = await this.db
      .delete(authSessions)
      .where(eq(authSessions.userId, authUserId))
      .returning({ id: authSessions.id })
    return removed.length
  }

  /** Sessions of one account, for the screen that lets someone end them. */
  async listSessions(
    authUserId: string,
  ): Promise<{ id: string; createdAt: Date; expiresAt: Date; ipAddress: string | null }[]> {
    const rows = await this.db
      .select({
        id: authSessions.id,
        createdAt: authSessions.createdAt,
        expiresAt: authSessions.expiresAt,
        ipAddress: authSessions.ipAddress,
      })
      .from(authSessions)
      .where(eq(authSessions.userId, authUserId))
      .orderBy(asc(authSessions.createdAt))
    return rows
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const removed = await this.db
      .delete(authSessions)
      .where(eq(authSessions.id, sessionId))
      .returning({ id: authSessions.id })
    return removed.length > 0
  }

  /** Marks a role as demanding a second factor from everyone who holds it. */
  async setRoleRequiresTwoFactor(name: string, required: boolean): Promise<void> {
    await this.db
      .update(staffRoles)
      .set({ requiresTwoFactor: required, updatedAt: new Date() })
      .where(eq(staffRoles.name, name))
  }

  async listMembers(): Promise<StaffMember[]> {
    const rows = await this.db.select().from(staffMembers).orderBy(asc(staffMembers.email))
    return rows.map(toMember)
  }

  async findMember(authUserId: string): Promise<StaffMember | null> {
    const [row] = await this.db
      .select()
      .from(staffMembers)
      .where(eq(staffMembers.authUserId, authUserId))
      .limit(1)
    return row === undefined ? null : toMember(row)
  }

  /**
   * Turns an authenticated account into a principal.
   *
   * Returns `null` for an account that is not staff here or has been
   * deactivated - an account with no role in this tenant has no access to it,
   * whatever it holds elsewhere.
   */
  async resolvePrincipal(authUserId: string): Promise<Principal | null> {
    const [row] = await this.db
      .select({
        member: staffMembers,
        email: authUsers.email,
        twoFactorEnabled: authUsers.twoFactorEnabled,
      })
      .from(staffMembers)
      .innerJoin(authUsers, eq(authUsers.id, staffMembers.authUserId))
      .where(and(eq(staffMembers.authUserId, authUserId), eq(staffMembers.isActive, true)))
      .limit(1)

    if (row === undefined) return null

    return {
      kind: 'staff',
      id: row.member.id,
      authUserId: row.member.authUserId,
      displayName: row.member.displayName,
      roles: row.member.roles,
      permissions: await this.permissionsOf(row.member.roles),
      twoFactorEnabled: row.twoFactorEnabled ?? false,
      requiresTwoFactor: await this.rolesRequireTwoFactor(row.member.roles),
    }
  }

  /** Whether any of these roles demands a second factor. */
  async rolesRequireTwoFactor(roles: readonly string[]): Promise<boolean> {
    if (roles.length === 0) return false
    const rows = await this.db
      .select({ required: staffRoles.requiresTwoFactor })
      .from(staffRoles)
      .where(inArray(staffRoles.name, [...roles]))
    return rows.some((row) => row.required)
  }
}

function toMember(row: {
  id: string
  authUserId: string
  displayName: string
  email: string
  roles: string[]
  isActive: boolean
}): StaffMember {
  return {
    id: row.id,
    authUserId: row.authUserId,
    displayName: row.displayName,
    email: row.email,
    roles: row.roles,
    isActive: row.isActive,
  }
}

export type { SystemRole }
