/**
 * What the customer import needs from a previous system, and nothing more.
 *
 * A port, like the catalog import's: a reader knows one foreign schema and none
 * of our rules; the engine knows our rules and no foreign schema. A reader
 * never returns a credential of any kind - not a password hash, not a reset
 * token - and the engine has nowhere to put one.
 */

export interface LegacyCustomer {
  /** The previous system's identifier. Re-runs match on it. */
  readonly legacyId: string
  readonly email?: string
  readonly phone?: string
  readonly firstName?: string
  readonly lastName?: string
  readonly company?: string
  /** Group identifiers in the previous system's own naming. */
  readonly groups: readonly string[]
  /** Marked deleted in the source. */
  readonly deleted: boolean
  /** A guest checkout rather than an account. */
  readonly guest: boolean
}

export interface LegacyAddress {
  readonly legacyId: string
  readonly customerLegacyId: string
  readonly recipientName?: string
  readonly phone?: string
  readonly city?: string
  /** The address as the customer wrote it. */
  readonly addressText: string
  readonly deleted: boolean
}

/** Reads a previous system. Read-only by contract. */
export interface LegacyCustomerReader {
  /** Names the source in reports and in stored previous identifiers. */
  readonly sourceName: string
  readCustomers(): Promise<readonly LegacyCustomer[]>
  readAddresses(): Promise<readonly LegacyAddress[]>
  /**
   * The source's groups onto our customer group codes.
   *
   * `null` says "this group means no special prices" (the ordinary customer
   * groups). A group absent from the mapping is one nobody decided about, and
   * a customer in it is reported rather than guessed.
   */
  groupMapping(): Promise<Readonly<Record<string, string | null>>>
}
