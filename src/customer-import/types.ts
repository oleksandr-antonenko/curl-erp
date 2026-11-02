/*
 * Proposals and reports name customers by the previous system's identifiers
 * and nothing else. They are stored, shown on screens and pasted into chats;
 * an email or a phone number in one of them is personal data in a place no
 * access rule watches.
 */

export type ProposedCustomerAction = 'create' | 'update' | 'refuse'

export interface ProposedCustomer {
  /** Every source identifier this one customer absorbs, the primary first. */
  readonly legacyIds: readonly string[]
  readonly action: ProposedCustomerAction
  readonly reason?: string
  /** Our customer group code, or null for none. */
  readonly group: string | null
  /** Set when the source put this person in several mapped groups. */
  readonly groupChoice?: { readonly among: readonly (string | null)[]; readonly chose: string | null }
  /** Names of the fields an update would change - never their values. */
  readonly changedFields?: readonly string[]
  readonly addressCount: number
}

export interface CustomerImportProposal {
  readonly source: string
  readonly sourceRecords: number
  readonly customers: readonly ProposedCustomer[]
  readonly counts: Readonly<Record<ProposedCustomerAction, number>>
  /** Pairs sharing a phone with different emails. Not merged; a person decides. */
  readonly possibleDuplicates: readonly (readonly [string, string])[]
  /** Customers whose source groups include one nobody mapped. */
  readonly unmappedGroups: readonly { readonly legacyId: string; readonly groups: readonly string[] }[]
}

export interface GroupReconciliation {
  readonly group: string
  /** Source customers that should land in this group. */
  readonly source: number
  /** Customers from this source that are in it after applying. */
  readonly imported: number
}

export interface CustomerImportReport {
  readonly source: string
  readonly sourceRecords: number
  readonly imported: number
  readonly merged: number
  readonly skipped: number
  readonly failed: number
  readonly refusals: readonly { readonly legacyId: string; readonly reason: string }[]
  readonly merges: readonly { readonly into: string; readonly absorbed: readonly string[] }[]
  readonly possibleDuplicates: readonly (readonly [string, string])[]
  readonly groups: readonly GroupReconciliation[]
  readonly groupChoices: readonly {
    readonly legacyId: string
    readonly among: readonly (string | null)[]
    readonly chose: string | null
  }[]
  readonly unmappedGroups: readonly { readonly legacyId: string; readonly groups: readonly string[] }[]
  readonly addresses: {
    readonly imported: number
    readonly skipped: readonly { readonly legacyId: string; readonly reason: string }[]
  }
  readonly needsAttention: string | null
}
