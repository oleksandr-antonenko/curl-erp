import { type ControlPlane, FileControlPlane } from './control-plane.js'
import { TenantConfigurationError } from './tenant.js'

export interface RuntimeEnvironment {
  readonly CONTROL_PLANE_FILE?: string | undefined
  readonly ADMIN_DATABASE_URL?: string | undefined
}

/**
 * Builds the control plane a process should use.
 *
 * A single-tenant installation names a file and needs nothing else - no second
 * database to install, back up or keep in sync. That is what keeps the
 * self-hosted build and the hosted one on the same code path.
 */
export function controlPlaneFromEnv(env: RuntimeEnvironment = process.env): ControlPlane {
  const file = env.CONTROL_PLANE_FILE
  if (file !== undefined && file !== '') return new FileControlPlane(file)

  throw new TenantConfigurationError(
    'No control plane configured. Set CONTROL_PLANE_FILE to the tenant registry file.',
  )
}

/** Maintenance connection used to create and drop tenant databases. */
export function adminDatabaseUrlFromEnv(env: RuntimeEnvironment = process.env): string {
  const url = env.ADMIN_DATABASE_URL
  if (url === undefined || url === '') {
    throw new TenantConfigurationError(
      'ADMIN_DATABASE_URL is not set. It must be a connection able to CREATE DATABASE.',
    )
  }
  return url
}
