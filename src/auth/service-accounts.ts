import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { isPermission, type Permission } from './permissions.js'
import type { Principal } from './principal.js'
import { serviceAccounts } from './schema.js'

export class ServiceAccountError extends Error {
  override readonly name = 'ServiceAccountError'
}

export interface ServiceAccount {
  readonly id: string
  readonly name: string
  readonly keyPrefix: string
  readonly permissions: readonly Permission[]
  readonly isActive: boolean
  readonly lastUsedAt: Date | null
  readonly revokedAt: Date | null
  readonly createdAt: Date
}

export interface IssuedServiceAccount {
  readonly account: ServiceAccount
  /** Shown once. Only a hash is stored. */
  readonly key: string
}

/** `erp_<hex prefix>_<base64url secret>`; the secret may contain "_" itself. */
const KEY_PATTERN = /^erp_([0-9a-f]+)_(.+)$/

const KEY_PREFIX_BYTES = 6
const KEY_SECRET_BYTES = 32

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function equalHashes(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Credentials for integrations.
 *
 * An integration that signs in as a person is indistinguishable from that
 * person in the audit log and cannot be revoked without locking them out, so
 * it gets its own identity, its own permissions and its own off switch.
 */
export class ServiceAccounts {
  constructor(
    private readonly db: Database,
    private readonly options: { readonly now?: () => Date } = {},
  ) {}

  private get clock(): () => Date {
    return this.options.now ?? ((): Date => new Date())
  }

  async create(input: {
    name: string
    permissions: readonly string[]
    createdBy?: string
  }): Promise<IssuedServiceAccount> {
    const unknown = input.permissions.filter((permission) => !isPermission(permission))
    if (unknown.length > 0) {
      throw new ServiceAccountError(`Unknown permissions: ${unknown.join(', ')}`)
    }

    const prefix = randomBytes(KEY_PREFIX_BYTES).toString('hex')
    const secret = randomBytes(KEY_SECRET_BYTES).toString('base64url')
    const key = `erp_${prefix}_${secret}`

    const [row] = await this.db
      .insert(serviceAccounts)
      .values({
        name: input.name,
        keyPrefix: prefix,
        keyHash: hash(secret),
        permissions: [...input.permissions],
        createdBy: input.createdBy ?? null,
      })
      .returning()

    if (row === undefined) throw new ServiceAccountError('Failed to create service account')
    return { account: toAccount(row), key }
  }

  /**
   * Turns a presented key into a principal.
   *
   * Returns `null` for anything that does not check out - unknown, revoked or
   * wrong - so the caller cannot accidentally tell those apart in a response.
   */
  async verify(key: string): Promise<Principal | null> {
    // Anchored parse rather than a split: the secret is base64url, which itself
    // contains "_", so splitting on the separator silently truncates it and
    // every key containing one is rejected as wrong.
    const match = KEY_PATTERN.exec(key)
    const prefix = match?.[1]
    const secret = match?.[2]
    if (prefix === undefined || secret === undefined) return null

    const [row] = await this.db
      .select()
      .from(serviceAccounts)
      .where(and(eq(serviceAccounts.keyPrefix, prefix), eq(serviceAccounts.isActive, true)))
      .limit(1)

    if (row === undefined || !equalHashes(row.keyHash, hash(secret))) return null

    await this.db
      .update(serviceAccounts)
      .set({ lastUsedAt: this.clock() })
      .where(eq(serviceAccounts.id, row.id))

    return {
      kind: 'service',
      id: row.id,
      displayName: row.name,
      roles: [],
      permissions: new Set(row.permissions.filter(isPermission)),
    }
  }

  async revoke(id: string): Promise<void> {
    await this.db
      .update(serviceAccounts)
      .set({ isActive: false, revokedAt: this.clock() })
      .where(eq(serviceAccounts.id, id))
  }

  async list(): Promise<ServiceAccount[]> {
    const rows = await this.db.select().from(serviceAccounts).orderBy(asc(serviceAccounts.name))
    return rows.map(toAccount)
  }
}

function toAccount(row: {
  id: string
  name: string
  keyPrefix: string
  permissions: string[]
  isActive: boolean
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}): ServiceAccount {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    permissions: row.permissions.filter(isPermission),
    isActive: row.isActive,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  }
}
