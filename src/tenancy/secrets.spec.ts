import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SecretsCipher, SecretsConfigurationError, SecretsDecryptionError } from './secrets.js'

const key = (): string => randomBytes(32).toString('base64')

describe('secrets cipher', () => {
  it('round-trips a value', () => {
    const cipher = SecretsCipher.fromBase64Key(key())
    const token = 'uXjKq2-live-98f7a6b5c4d3'
    expect(cipher.decrypt(cipher.encrypt(token))).toBe(token)
  })

  it('never produces the same ciphertext twice', () => {
    const cipher = SecretsCipher.fromBase64Key(key())
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'))
  })

  it('does not leak the value into the ciphertext', () => {
    const cipher = SecretsCipher.fromBase64Key(key())
    const encrypted = cipher.encrypt('super-secret-token')
    expect(encrypted).not.toContain('super-secret-token')
    expect(Buffer.from(encrypted, 'base64').toString('utf8')).not.toContain('super-secret')
  })

  it('refuses a value altered in storage', () => {
    const cipher = SecretsCipher.fromBase64Key(key())
    const encrypted = cipher.encrypt('token')
    const raw = Buffer.from(encrypted, 'base64')
    raw[raw.length - 1] ^= 0xff
    expect(() => cipher.decrypt(raw.toString('base64'))).toThrow(SecretsDecryptionError)
  })

  it('refuses a value written with another key', () => {
    const encrypted = SecretsCipher.fromBase64Key(key()).encrypt('token')
    expect(() => SecretsCipher.fromBase64Key(key()).decrypt(encrypted)).toThrow(SecretsDecryptionError)
  })

  it('refuses a truncated value', () => {
    const cipher = SecretsCipher.fromBase64Key(key())
    expect(() => cipher.decrypt('c2hvcnQ=')).toThrow(SecretsDecryptionError)
  })

  it('rejects a key of the wrong length', () => {
    expect(() => SecretsCipher.fromBase64Key(randomBytes(16).toString('base64'))).toThrow(
      SecretsConfigurationError,
    )
  })

  it('explains how to generate a key when none is configured', () => {
    expect(() => SecretsCipher.fromEnv({})).toThrow(/SECRETS_ENCRYPTION_KEY/)
  })

  it('compares values without leaking length through timing', () => {
    expect(SecretsCipher.matches('abc', 'abc')).toBe(true)
    expect(SecretsCipher.matches('abc', 'abd')).toBe(false)
    expect(SecretsCipher.matches('abc', 'abcd')).toBe(false)
  })
})
