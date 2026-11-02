export {
  type ChannelCapabilities,
  type ChannelCustomer,
  type ChannelCustomerGroupMembership,
  type ChannelDelivery,
  ChannelError,
  type ChannelMedia,
  type ChannelOrder,
  type ChannelOrderLine,
  type ChannelOrderStatus,
  type ChannelOrderStatusUpdate,
  type ChannelPrice,
  type ChannelProductInput,
  type ChannelProductResult,
  type ChannelStockLevel,
  type ChannelStockReport,
  type ChannelVariantInput,
  MINIMAL_CAPABILITIES,
  type SalesChannelAdapter,
} from './contract.js'
export {
  type ContractSuiteOptions,
  runChannelContractTests,
  type TestPrimitives,
} from './contract-tests.js'
export { ChannelCustomerGroups, type GroupReconciliation } from './customer-groups.js'
export {
  ChannelCustomers,
  type Counterparty,
  type CustomerResolution,
  type MatchingRules,
} from './customers.js'
export { ChannelMappings, type MappedEntity } from './mappings.js'
export {
  createChannelAdapter as createMemoryChannelAdapter,
  MemoryChannelAdapter,
  type MemoryChannelOptions,
  type MemoryListing,
} from './memory-adapter.js'
export {
  ChannelOrders,
  type InboxOrder,
  type InboxState,
  type IntakeResult,
  type OrderIntakeOptions,
  payloadToOrder,
  type ResolveDecision,
  totalsMismatch,
} from './orders.js'
export {
  ChannelOutbound,
  type DispatchResult,
  type OutboundItem,
  type OutboundKind,
  type OutboundOptions,
  type OutboundStatus,
} from './outbound.js'
export {
  ChannelPayments,
  type PaymentMismatch,
  type PaymentNotification,
  type PaymentRecord,
  type RecordResult,
} from './payments.js'
export {
  ChannelPublications,
  decidePublication,
  type PublicationDecision,
  type PublicationRule,
} from './publications.js'
export {
  type ChannelAdapterModule,
  type ChannelAvailability,
  type ChannelConfiguration,
  ChannelNotAvailableError,
  ChannelRegistry,
  type ChannelStatus,
  channelConfigurationFromEnv,
} from './registry.js'
export {
  type ChannelDriftRow,
  type ChannelInboxOrderRow,
  type ChannelMappingRow,
  type ChannelOutboundRow,
  type ChannelPaymentRow,
  type ChannelPublicationRow,
  channelDrift,
  channelInboxOrders,
  channelMappings,
  channelOutbound,
  channelPayments,
  channelPublications,
  channelState,
  counterpartyIdentities,
} from './schema.js'
export {
  ChannelStock,
  type DriftEntry,
  type ReconciliationResult,
  type StockSource,
} from './stock.js'
export {
  type CatalogSource,
  ChannelSync,
  type ChannelSyncOptions,
  type SyncResult,
} from './sync.js'
