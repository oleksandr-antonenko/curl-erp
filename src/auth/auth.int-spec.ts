import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/client.js'
import { createTenantFixture, type TenantFixture } from '../testing/index.js'
import { AuditTamperError, SecurityAudit } from './audit.js'
import { RoleError, StaffDirectory } from './directory.js'
import { InvitationError, StaffInvitations } from './invitations.js'
import { AuthorizationError, authorize, can } from './principal.js'
import {
  authUsers,
  securityEvents,
  serviceAccounts,
  staffInvitations,
  staffMembers,
  staffRoles,
} from './schema.js'
import { ServiceAccountError, ServiceAccounts } from './service-accounts.js'

describe('staff access', () => {
  let fixture: TenantFixture
  let db: Database
  let directory: StaffDirectory

  const createAccount = async (email: string): Promise<string> => {
    const id = randomUUID()
    await db.insert(authUsers).values({ id, name: email, email, emailVerified: true })
    return id
  }

  beforeAll(async () => {
    fixture = await createTenantFixture(['auth'], { migrate: true })
    db = fixture.registry.connectTo(fixture.tenant('auth')).db
    directory = new StaffDirectory(db)
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  beforeEach(async () => {
    await db.delete(staffInvitations)
    await db.delete(staffMembers)
    await db.delete(serviceAccounts)
    await db.execute(sql`delete from ${authUsers}`)
    await db.delete(staffRoles)
    await directory.ensureSystemRoles()
  })

  describe('roles', () => {
    it('installs the roles that ship with the product', async () => {
      const roles = await directory.listRoles()
      expect(roles.map((role) => role.name).sort()).toEqual([
        'accountant',
        'manager',
        'owner',
        'viewer',
        'warehouse',
      ])
      expect(roles.every((role) => role.isSystem)).toBe(true)
    })

    it('is safe to install twice', async () => {
      await directory.ensureSystemRoles()
      expect(await directory.listRoles()).toHaveLength(5)
    })

    it('accepts a custom role limited to what it names', async () => {
      const role = await directory.createRole('price-editor', ['price.read', 'price.write'], 'Prices only')
      expect(role.isSystem).toBe(false)

      const accountId = await createAccount('editor@example.com')
      await directory.addMember({
        authUserId: accountId,
        displayName: 'Editor',
        email: 'editor@example.com',
        roles: ['price-editor'],
      })

      const principal = await directory.resolvePrincipal(accountId)
      expect(principal).not.toBeNull()
      if (principal === null) return
      expect(can(principal, 'price.write')).toBe(true)
      expect(can(principal, 'ledger.post')).toBe(false)
      expect(can(principal, 'catalog.write')).toBe(false)
    })

    it('refuses a role naming a permission that does not exist', async () => {
      await expect(directory.createRole('bad', ['ledger.destroy'])).rejects.toThrow(RoleError)
    })

    it('refuses to redefine a system role', async () => {
      await expect(directory.createRole('owner', ['catalog.read'])).rejects.toThrow(RoleError)
    })

    it('combines the permissions of several roles', async () => {
      const accountId = await createAccount('multi@example.com')
      await directory.addMember({
        authUserId: accountId,
        displayName: 'Multi',
        email: 'multi@example.com',
        roles: ['warehouse', 'accountant'],
      })

      const principal = await directory.resolvePrincipal(accountId)
      if (principal === null) throw new Error('expected a principal')
      expect(can(principal, 'inventory.write')).toBe(true)
      expect(can(principal, 'ledger.post')).toBe(true)
    })
  })

  describe('membership', () => {
    it('refuses an account that is not staff here', async () => {
      const stranger = await createAccount('stranger@example.com')
      expect(await directory.resolvePrincipal(stranger)).toBeNull()
    })

    it('refuses an account with no roles nothing beyond nothing', async () => {
      const accountId = await createAccount('empty@example.com')
      await directory.addMember({
        authUserId: accountId,
        displayName: 'Empty',
        email: 'empty@example.com',
        roles: [],
      })
      const principal = await directory.resolvePrincipal(accountId)
      expect(principal?.permissions.size).toBe(0)
      if (principal !== null) {
        expect(() => authorize(principal, 'catalog.read')).toThrow(AuthorizationError)
      }
    })

    it('cuts off a deactivated member immediately', async () => {
      const accountId = await createAccount('leaver@example.com')
      await directory.addMember({
        authUserId: accountId,
        displayName: 'Leaver',
        email: 'leaver@example.com',
        roles: ['manager'],
      })
      expect(await directory.resolvePrincipal(accountId)).not.toBeNull()

      await directory.setActive(accountId, false)
      expect(await directory.resolvePrincipal(accountId)).toBeNull()

      await directory.setActive(accountId, true)
      expect(await directory.resolvePrincipal(accountId)).not.toBeNull()
    })

    it('changes roles without recreating the person', async () => {
      const accountId = await createAccount('promoted@example.com')
      await directory.addMember({
        authUserId: accountId,
        displayName: 'Promoted',
        email: 'promoted@example.com',
        roles: ['viewer'],
      })
      const before = await directory.resolvePrincipal(accountId)
      expect(can(before as never, 'catalog.write')).toBe(false)

      await directory.setRoles(accountId, ['manager'])
      const after = await directory.resolvePrincipal(accountId)
      expect(can(after as never, 'catalog.write')).toBe(true)
      expect(after?.id).toBe(before?.id)
    })
  })

  describe('invitations', () => {
    it('creates an account only through an invitation', async () => {
      const invitations = new StaffInvitations(db)
      const { token, invitation } = await invitations.invite({
        email: 'new@example.com',
        roles: ['warehouse'],
        invitedBy: 'owner-1',
      })

      expect(invitation.acceptedAt).toBeNull()
      expect(token).not.toBe('')

      const accountId = await createAccount('new@example.com')
      const member = await invitations.accept(token, {
        authUserId: accountId,
        displayName: 'Newcomer',
        email: 'new@example.com',
      })

      expect(member.roles).toEqual(['warehouse'])
      const principal = await directory.resolvePrincipal(accountId)
      expect(can(principal as never, 'inventory.write')).toBe(true)
    })

    it('lets an invitation be used only once', async () => {
      const invitations = new StaffInvitations(db)
      const { token } = await invitations.invite({ email: 'once@example.com', roles: ['viewer'] })

      const first = await createAccount('once@example.com')
      await invitations.accept(token, {
        authUserId: first,
        displayName: 'First',
        email: 'once@example.com',
      })

      const second = await createAccount('once2@example.com')
      await expect(
        invitations.accept(token, {
          authUserId: second,
          displayName: 'Second',
          email: 'once@example.com',
        }),
      ).rejects.toThrow(InvitationError)
    })

    it('refuses an expired invitation and leaves it unaccepted', async () => {
      let now = new Date('2026-01-01T00:00:00Z')
      const invitations = new StaffInvitations(db, { ttlMs: 1000, now: () => now })
      const { token, invitation } = await invitations.invite({
        email: 'late@example.com',
        roles: ['viewer'],
      })

      now = new Date('2026-01-02T00:00:00Z')
      const accountId = await createAccount('late@example.com')
      await expect(
        invitations.accept(token, {
          authUserId: accountId,
          displayName: 'Late',
          email: 'late@example.com',
        }),
      ).rejects.toThrow(/expired/)

      expect((await invitations.find(token))?.acceptedAt).toBeNull()
      expect(await directory.resolvePrincipal(accountId)).toBeNull()
      expect(invitation.expiresAt.getTime()).toBeLessThan(now.getTime())
    })

    it('refuses an invitation redirected to another address', async () => {
      const invitations = new StaffInvitations(db)
      const { token } = await invitations.invite({ email: 'target@example.com', roles: ['viewer'] })

      const accountId = await createAccount('someone-else@example.com')
      await expect(
        invitations.accept(token, {
          authUserId: accountId,
          displayName: 'Impostor',
          email: 'someone-else@example.com',
        }),
      ).rejects.toThrow(/different address/)
    })

    it('refuses a revoked invitation', async () => {
      const invitations = new StaffInvitations(db)
      const { token, invitation } = await invitations.invite({
        email: 'revoked@example.com',
        roles: ['viewer'],
      })
      await invitations.revoke(invitation.id)

      const accountId = await createAccount('revoked@example.com')
      await expect(
        invitations.accept(token, {
          authUserId: accountId,
          displayName: 'Nope',
          email: 'revoked@example.com',
        }),
      ).rejects.toThrow(InvitationError)
    })

    it('never stores the token itself', async () => {
      const invitations = new StaffInvitations(db)
      const { token } = await invitations.invite({ email: 'x@example.com', roles: [] })
      const rows = await db.select().from(staffInvitations)
      expect(JSON.stringify(rows)).not.toContain(token)
    })
  })

  describe('service accounts', () => {
    it('issues a key that resolves to its own permissions', async () => {
      const accounts = new ServiceAccounts(db)
      const { key, account } = await accounts.create({
        name: 'storefront',
        permissions: ['catalog.read', 'document.write'],
      })

      expect(key.startsWith('erp_')).toBe(true)
      const principal = await accounts.verify(key)
      expect(principal?.kind).toBe('service')
      expect(principal?.id).toBe(account.id)
      expect(can(principal as never, 'document.write')).toBe(true)
      expect(can(principal as never, 'ledger.post')).toBe(false)
    })

    it('refuses a revoked key', async () => {
      const accounts = new ServiceAccounts(db)
      const { key, account } = await accounts.create({ name: 'temp', permissions: ['catalog.read'] })
      expect(await accounts.verify(key)).not.toBeNull()

      await accounts.revoke(account.id)
      expect(await accounts.verify(key)).toBeNull()
    })

    it('accepts a key whose secret contains the separator', async () => {
      const accounts = new ServiceAccounts(db)
      // The secret is base64url, which uses "_" - the same character that
      // separates the parts of the key. Splitting on it truncates the secret,
      // and roughly every other key is then rejected as wrong.
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const { key } = await accounts.create({ name: `probe-${attempt}`, permissions: [] })
        expect(await accounts.verify(key)).not.toBeNull()
      }
    })

    it('refuses a made-up key without saying why', async () => {
      const accounts = new ServiceAccounts(db)
      expect(await accounts.verify('erp_deadbeef_nonsense')).toBeNull()
      expect(await accounts.verify('not-a-key')).toBeNull()
    })

    it('never stores the key itself', async () => {
      const accounts = new ServiceAccounts(db)
      const { key } = await accounts.create({ name: 'hidden', permissions: [] })
      const secret = /^erp_[0-9a-f]+_(.+)$/.exec(key)?.[1]
      expect(secret).toBeDefined()

      const rows = await db.select().from(serviceAccounts)
      expect(JSON.stringify(rows)).not.toContain(secret as string)
      expect(JSON.stringify(rows)).not.toContain(key)
    })

    it('refuses permissions that do not exist', async () => {
      const accounts = new ServiceAccounts(db)
      await expect(accounts.create({ name: 'bad', permissions: ['everything'] })).rejects.toThrow(
        ServiceAccountError,
      )
    })

    it('records when a key was last used', async () => {
      const accounts = new ServiceAccounts(db)
      const { key, account } = await accounts.create({ name: 'used', permissions: [] })
      await accounts.verify(key)

      const listed = (await accounts.list()).find((entry) => entry.id === account.id)
      expect(listed?.lastUsedAt).toBeInstanceOf(Date)
    })
  })

  describe('security audit', () => {
    beforeEach(async () => {
      // TRUNCATE, because DELETE is blocked by the append-only trigger - which
      // is the behaviour one of these tests is about. The trigger defends the
      // log against the application; it cannot defend it against whoever owns
      // the database, and it does not pretend to.
      await db.execute(sql`truncate table ${securityEvents}`)
    })

    it('records who changed whose roles', async () => {
      const audit = new SecurityAudit(db)
      await audit.record({
        kind: 'staff.roles_changed',
        actor: { kind: 'staff', id: 'owner-1' },
        subjectType: 'staff',
        subjectId: 'member-9',
        detail: { added: ['accountant'] },
      })

      const [event] = await audit.list({ kind: 'staff.roles_changed' })
      expect(event?.actorId).toBe('owner-1')
      expect(event?.subjectId).toBe('member-9')
      expect(event?.detail).toEqual({ added: ['accountant'] })
      expect(event?.occurredAt).toBeInstanceOf(Date)
    })

    it('records failed sign-ins as well as successful ones', async () => {
      const audit = new SecurityAudit(db)
      await audit.record({ kind: 'sign_in.failed', subjectId: 'a@example.com', ipAddress: '10.0.0.1' })
      await audit.record({ kind: 'sign_in.succeeded', subjectId: 'a@example.com' })

      expect(await audit.list({ subjectId: 'a@example.com' })).toHaveLength(2)
      expect(await audit.list({ kind: 'sign_in.failed' })).toHaveLength(1)
    })

    it('cannot be altered, even by the application', async () => {
      const audit = new SecurityAudit(db)
      await audit.record({ kind: 'sign_in.succeeded', subjectId: 'victim@example.com' })

      // The driver error is wrapped by the query layer, so the reason the
      // database gave lives on the cause rather than on the outer message.
      const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
        try {
          await promise
          return 'no error was raised'
        } catch (error) {
          const cause = (error as { cause?: { message?: string } }).cause
          return cause?.message ?? (error as Error).message
        }
      }

      expect(await reasonOf(db.execute(sql`update ${securityEvents} set kind = 'sign_out'`))).toMatch(
        /append-only/,
      )
      expect(await reasonOf(db.execute(sql`delete from ${securityEvents}`))).toMatch(/append-only/)

      expect(await audit.list()).toHaveLength(1)
      expect((await audit.list())[0]?.kind).toBe('sign_in.succeeded')
    })

    it('records an attempt to tamper with it', async () => {
      const audit = new SecurityAudit(db)
      await expect(
        audit.refuseTamper({ kind: 'staff', id: 'sneaky' }, 'delete sign-in records'),
      ).rejects.toThrow(AuditTamperError)

      const [event] = await audit.list({ kind: 'audit.tamper_attempt' })
      expect(event?.actorId).toBe('sneaky')
      expect(event?.detail).toEqual({ attempted: 'delete sign-in records' })
    })
  })
})
