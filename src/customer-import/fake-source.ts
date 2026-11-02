import type { LegacyAddress, LegacyCustomer, LegacyCustomerReader } from './contract.js'

/** An in-memory previous system, for tests and for trying the engine out. */
export class FakeCustomerSource implements LegacyCustomerReader {
  readonly sourceName: string
  customers: LegacyCustomer[]
  addresses: LegacyAddress[]
  groups: Record<string, string | null>

  constructor(
    options: {
      sourceName?: string
      customers?: LegacyCustomer[]
      addresses?: LegacyAddress[]
      groups?: Record<string, string | null>
    } = {},
  ) {
    this.sourceName = options.sourceName ?? 'previous shop'
    this.customers = options.customers ?? []
    this.addresses = options.addresses ?? []
    this.groups = options.groups ?? { '3': null, '4': 'wholesale' }
  }

  async readCustomers(): Promise<readonly LegacyCustomer[]> {
    return this.customers
  }

  async readAddresses(): Promise<readonly LegacyAddress[]> {
    return this.addresses
  }

  async groupMapping(): Promise<Readonly<Record<string, string | null>>> {
    return this.groups
  }
}
