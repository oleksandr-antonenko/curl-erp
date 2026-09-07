export type {
  LegacyCatalogReader,
  LegacyCategory,
  LegacyImage,
  LegacyPrice,
  LegacyProduct,
  LegacyText,
} from './contract.js'
export { ImportError, ProposalNotApplicableError } from './errors.js'
export { CatalogImport, type CatalogImportOptions, effectiveAmount } from './import.js'
export { catalogImports } from './schema.js'
export type {
  ImportGaps,
  ImportProposal,
  ImportReport,
  PriceDifference,
  ProposedAction,
  ProposedPrice,
  ProposedProduct,
} from './types.js'
