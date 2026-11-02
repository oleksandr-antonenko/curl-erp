export type { LegacyAddress, LegacyCustomer, LegacyCustomerReader } from './contract.js'
export { FakeCustomerSource } from './fake-source.js'
export { CustomerImport, type CustomerImportOptions } from './import.js'
export { type CustomerImportRow, customerImports } from './schema.js'
export type {
  CustomerImportProposal,
  CustomerImportReport,
  GroupReconciliation,
  ProposedCustomer,
  ProposedCustomerAction,
} from './types.js'
