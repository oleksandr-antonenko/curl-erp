import type { ControlPlane } from './control-plane.js'
import type { TenantRecord } from './tenant.js'

/** What the transport knows about an incoming request. */
export interface TenantResolutionRequest {
  /** Host header, without the port. */
  readonly host?: string | undefined
  /** Tenant id explicitly named by the client, e.g. in a header. */
  readonly requestedTenantId?: string | undefined
  /**
   * Whether the caller presented credentials that have already been verified.
   *
   * An explicitly named tenant is only honoured for an authenticated caller:
   * accepting a bare header would let anyone point a request at any tenant and
   * learn, from the response, which tenant ids exist.
   */
  readonly hasVerifiedCredentials?: boolean | undefined
}

export type TenantResolutionRule = 'single' | 'host' | 'header'

export interface TenantResolverOptions {
  /**
   * Rules to try, in order. Defaults to host, then an authenticated header,
   * then falling back to the sole tenant of a single-tenant installation.
   */
  readonly rules?: readonly TenantResolutionRule[]
}

const DEFAULT_RULES: readonly TenantResolutionRule[] = ['host', 'header', 'single']

/** Which tenant was found, and by which rule - the caller may owe extra checks. */
export interface TenantResolution {
  readonly tenant: TenantRecord
  readonly rule: TenantResolutionRule
}

function normaliseHost(host: string | undefined): string | null {
  if (host === undefined || host === '') return null
  const withoutPort = host.split(':')[0] ?? host
  return withoutPort.trim().toLowerCase()
}

/**
 * Turns an incoming request into a tenant, or into nothing.
 *
 * Returning `null` covers "no such tenant" and "suspended tenant" alike. The
 * caller must answer both the same way: a distinguishable response would let an
 * outsider enumerate customers, and for a suspended tenant it would also
 * confirm the account exists to someone who should no longer reach it.
 */
export class TenantResolver {
  private readonly rules: readonly TenantResolutionRule[]

  constructor(
    private readonly controlPlane: ControlPlane,
    options: TenantResolverOptions = {},
  ) {
    this.rules = options.rules ?? DEFAULT_RULES
  }

  async resolve(request: TenantResolutionRequest): Promise<TenantResolution | null> {
    for (const rule of this.rules) {
      const candidate = await this.applyRule(rule, request)
      if (candidate === null) continue
      return candidate.status === 'active' ? { tenant: candidate, rule } : null
    }
    return null
  }

  private async applyRule(
    rule: TenantResolutionRule,
    request: TenantResolutionRequest,
  ): Promise<TenantRecord | null> {
    switch (rule) {
      case 'host':
        return this.byHost(request.host)
      case 'header':
        return request.hasVerifiedCredentials === true ? this.byId(request.requestedTenantId) : null
      case 'single':
        return request.requestedTenantId === undefined ? this.sole() : null
    }
  }

  private async byHost(host: string | undefined): Promise<TenantRecord | null> {
    const wanted = normaliseHost(host)
    if (wanted === null) return null
    const tenants = await this.controlPlane.list()
    return (
      tenants.find((tenant) => tenant.hosts.some((candidate) => candidate.trim().toLowerCase() === wanted)) ??
      null
    )
  }

  private async byId(tenantId: string | undefined): Promise<TenantRecord | null> {
    if (tenantId === undefined || tenantId === '') return null
    return this.controlPlane.find(tenantId)
  }

  /**
   * The only tenant of a single-tenant installation.
   *
   * Deliberately counts every registered tenant, active or not: falling through
   * to "the only active one" would silently re-point traffic after somebody
   * suspends a tenant.
   */
  private async sole(): Promise<TenantRecord | null> {
    const tenants = await this.controlPlane.list()
    return tenants.length === 1 ? (tenants[0] ?? null) : null
  }
}
