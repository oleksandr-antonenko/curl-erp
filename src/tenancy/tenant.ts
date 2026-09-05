import { z } from 'zod'

/**
 * Tenant identifier. Also used to name the tenant's database and to label its
 * metrics, so it is restricted to what is safe in both places.
 */
export const tenantIdSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9_-]*$/, 'must start with a letter and contain only a-z, 0-9, "-" and "_"')

export const tenantStatusSchema = z.enum(['active', 'suspended'])
export type TenantStatus = z.infer<typeof tenantStatusSchema>

/**
 * A tenant is one customer of the ERP. Its business data lives in its own
 * database; this record is the only thing the control plane knows about it.
 */
export const tenantRecordSchema = z.object({
  id: tenantIdSchema,
  name: z.string().min(1).max(200),
  /**
   * Connection string for this tenant's database. May be written as
   * `${ENV_VAR}` so that a control-plane file committed to a repository holds
   * no credentials.
   */
  databaseUrl: z.string().min(1),
  /**
   * Host names this tenant answers on. Used by host-based resolution; empty in
   * a single-tenant installation, where there is nothing to disambiguate.
   */
  hosts: z.array(z.string().min(1)).default([]),
  status: tenantStatusSchema.default('active'),
  /**
   * Commercial modules this tenant is entitled to. Purely declarative: the core
   * never checks a licence key at runtime, and a module that is not installed
   * stays unavailable whatever this list says.
   */
  entitlements: z.array(z.string().min(1)).default([]),
})

export type TenantRecord = z.infer<typeof tenantRecordSchema>

/** Same record before defaults are applied - what a caller has to supply. */
export type TenantRecordInput = z.input<typeof tenantRecordSchema>

export const controlPlaneFileSchema = z.object({
  version: z.literal(1),
  tenants: z.array(tenantRecordSchema),
})

export type ControlPlaneFile = z.infer<typeof controlPlaneFileSchema>

export class TenantConfigurationError extends Error {
  override readonly name = 'TenantConfigurationError'
}

const ENV_REFERENCE = /^\$\{([A-Z0-9_]+)\}$/

/**
 * Resolves a `${ENV_VAR}` reference in a connection string.
 *
 * Credentials do not belong in a file that gets committed, but the tenant
 * registry does - so the file names the variable and the process supplies the
 * value.
 */
export function resolveDatabaseUrl(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const match = ENV_REFERENCE.exec(value)
  if (match === null) return value

  const name = match[1]
  if (name === undefined) return value

  const resolved = env[name]
  if (resolved === undefined || resolved === '') {
    throw new TenantConfigurationError(
      `Environment variable ${name} referenced by the control plane is not set`,
    )
  }
  return resolved
}

/** Parses and validates a control-plane document, rejecting duplicate ids. */
export function parseControlPlaneFile(input: unknown): ControlPlaneFile {
  const parsed = controlPlaneFileSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new TenantConfigurationError(`Invalid control plane document: ${issues}`)
  }

  const seen = new Set<string>()
  for (const tenant of parsed.data.tenants) {
    if (seen.has(tenant.id)) {
      throw new TenantConfigurationError(`Duplicate tenant id "${tenant.id}" in control plane`)
    }
    seen.add(tenant.id)
  }

  return parsed.data
}
