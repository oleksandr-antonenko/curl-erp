import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { currentDb } from './context.js'
import { tenantSecrets } from './schema.js'

const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export class SecretsConfigurationError extends Error {
  override readonly name = 'SecretsConfigurationError'
}

export class SecretsDecryptionError extends Error {
  override readonly name = 'SecretsDecryptionError'
}

/**
 * Authenticated encryption for integration credentials.
 *
 * Authenticated rather than plain: a bank token silently altered in the
 * database would be used to sign requests, and the failure would surface as a
 * refused payment rather than as tampering.
 */
export class SecretsCipher {
  private constructor(private readonly key: Buffer) {}

  static fromBase64Key(value: string): SecretsCipher {
    const key = Buffer.from(value, 'base64')
    if (key.length !== KEY_BYTES) {
      throw new SecretsConfigurationError(
        `Encryption key must be ${KEY_BYTES} bytes (base64). Generate one with: openssl rand -base64 32`,
      )
    }
    return new SecretsCipher(key)
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretsCipher {
    const value = env['SECRETS_ENCRYPTION_KEY']
    if (value === undefined || value === '') {
      throw new SecretsConfigurationError(
        'SECRETS_ENCRYPTION_KEY is not set; integration credentials cannot be stored.',
      )
    }
    return SecretsCipher.fromBase64Key(value)
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, nonce)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')
  }

  decrypt(payload: string): string {
    const raw = Buffer.from(payload, 'base64')
    if (raw.length < NONCE_BYTES + TAG_BYTES) {
      throw new SecretsDecryptionError('Stored secret is truncated')
    }
    const nonce = raw.subarray(0, NONCE_BYTES)
    const tag = raw.subarray(raw.length - TAG_BYTES)
    const ciphertext = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)

    const decipher = createDecipheriv(ALGORITHM, this.key, nonce)
    decipher.setAuthTag(tag)
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch {
      throw new SecretsDecryptionError(
        'Stored secret failed authentication: it was written with a different key, or altered.',
      )
    }
  }

  /** Constant-time comparison, for verifying a presented secret. */
  static matches(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8')
    const right = Buffer.from(b, 'utf8')
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }
}

/** What a read operation may show: enough to recognise a value, never the value. */
export interface SecretDescription {
  readonly name: string
  /** Last characters of the value, e.g. `••••4321`. Null for very short values. */
  readonly hint: string | null
  readonly updatedAt: Date
  readonly updatedBy: string | null
}

function maskOf(value: string): string | null {
  return value.length >= 8 ? `••••${value.slice(-4)}` : null
}

/**
 * Integration credentials for the tenant in scope.
 *
 * Reading and revealing are separate operations on purpose. Everything that
 * answers a person - listings, settings screens, exports - can only reach the
 * masked form, so a credential cannot leave through a route that was never
 * meant to carry one.
 */
export class TenantSecretsStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretsCipher,
  ) {}

  /** Binds a store to the tenant of the current scope. */
  static forCurrentTenant(cipher: SecretsCipher): TenantSecretsStore {
    return new TenantSecretsStore(currentDb(), cipher)
  }

  async set(name: string, value: string, updatedBy?: string): Promise<SecretDescription> {
    const now = new Date()
    const row = {
      name,
      ciphertext: this.cipher.encrypt(value),
      hint: maskOf(value),
      updatedAt: now,
      updatedBy: updatedBy ?? null,
    }

    const [saved] = await this.db
      .insert(tenantSecrets)
      .values(row)
      .onConflictDoUpdate({ target: tenantSecrets.name, set: row })
      .returning()

    if (saved === undefined) throw new Error(`Failed to store secret "${name}"`)
    return describe(saved)
  }

  /** Masked view of one secret. Safe to return over the wire. */
  async describe(name: string): Promise<SecretDescription | null> {
    const [row] = await this.db.select().from(tenantSecrets).where(eq(tenantSecrets.name, name)).limit(1)
    return row === undefined ? null : describe(row)
  }

  /** Masked view of every secret. Safe to return over the wire. */
  async list(): Promise<SecretDescription[]> {
    const rows = await this.db.select().from(tenantSecrets)
    return rows.map(describe).sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * The plain value, for server-side use by the integration that owns it.
   *
   * Must never be reachable from an HTTP route, a report or a log line.
   */
  async reveal(name: string): Promise<string | null> {
    const [row] = await this.db
      .select({ ciphertext: tenantSecrets.ciphertext })
      .from(tenantSecrets)
      .where(eq(tenantSecrets.name, name))
      .limit(1)
    return row === undefined ? null : this.cipher.decrypt(row.ciphertext)
  }

  async delete(name: string): Promise<boolean> {
    const removed = await this.db
      .delete(tenantSecrets)
      .where(and(eq(tenantSecrets.name, name)))
      .returning({ name: tenantSecrets.name })
    return removed.length > 0
  }
}

function describe(row: {
  name: string
  hint: string | null
  updatedAt: Date
  updatedBy: string | null
}): SecretDescription {
  return {
    name: row.name,
    hint: row.hint,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }
}
