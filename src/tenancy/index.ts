export {
  BackupError,
  type BackupResult,
  type BackupTenantOptions,
  type BackupToolPaths,
  backupTenant,
  LocalProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  type RestoreTenantOptions,
  restoreTenant,
} from './backup.js'
export {
  type Actor,
  bindTenantScope,
  currentActor,
  currentDb,
  currentScope,
  currentTenant,
  MissingActorError,
  MissingTenantContextError,
  requireActor,
  runInTenantScope,
  type TenantScope,
  tryCurrentScope,
  withActor,
} from './context.js'
export {
  type ControlPlane,
  FileControlPlane,
  StaticControlPlane,
  TenantAlreadyExistsError,
  TenantNotFoundError,
} from './control-plane.js'
export {
  type DatabaseRegistryOptions,
  type TenantConnection,
  TenantDatabaseRegistry,
  TenantSuspendedError,
} from './database-registry.js'
export {
  type TenantJob,
  type TenantJobReport,
  type TenantJobResult,
  TenantJobRunner,
  type TenantJobRunnerOptions,
  type TenantJobStatus,
} from './jobs.js'
export {
  type MigrationReport,
  migrateAllTenants,
  migrateTenant,
  migrationsFolder,
  readRequiredMigrations,
  readSchemaVersion,
  reportSchemaVersions,
  SchemaOutOfDateError,
  type SchemaVersion,
  SchemaVersionGuard,
  type TenantMigrationOutcome,
} from './migrations.js'
export {
  activateTenant,
  createTenantDatabase,
  type DeleteTenantOptions,
  databaseExists,
  databaseNameFor,
  deactivateTenant,
  deleteTenant,
  dropTenantDatabase,
  type ProvisionedTenant,
  type ProvisionTenantOptions,
  provisionTenant,
  TenantProvisioningError,
} from './provisioning.js'
export {
  type TenantResolutionRequest,
  type TenantResolutionRule,
  TenantResolver,
  type TenantResolverOptions,
} from './resolver.js'
export { adminDatabaseUrlFromEnv, controlPlaneFromEnv, type RuntimeEnvironment } from './runtime.js'
export { type NewTenantSecretRow, type TenantSecretRow, tenantSecrets } from './schema.js'
export {
  type SecretDescription,
  SecretsCipher,
  SecretsConfigurationError,
  SecretsDecryptionError,
  TenantSecretsStore,
} from './secrets.js'
export {
  type ControlPlaneFile,
  controlPlaneFileSchema,
  parseControlPlaneFile,
  resolveDatabaseUrl,
  TenantConfigurationError,
  type TenantRecord,
  type TenantStatus,
  tenantIdSchema,
  tenantRecordSchema,
  tenantStatusSchema,
} from './tenant.js'
