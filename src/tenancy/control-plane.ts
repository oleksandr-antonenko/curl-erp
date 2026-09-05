import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  type ControlPlaneFile,
  parseControlPlaneFile,
  TenantConfigurationError,
  type TenantRecord,
  type TenantRecordInput,
  tenantRecordSchema,
} from './tenant.js'

export class TenantNotFoundError extends Error {
  override readonly name = 'TenantNotFoundError'
  constructor(readonly tenantId: string) {
    super(`Tenant "${tenantId}" is not registered`)
  }
}

export class TenantAlreadyExistsError extends Error {
  override readonly name = 'TenantAlreadyExistsError'
  constructor(readonly tenantId: string) {
    super(`Tenant "${tenantId}" is already registered`)
  }
}

/**
 * The registry of tenants, kept apart from every tenant's business data.
 *
 * Two implementations exist for one reason: a single-tenant installation must
 * run with a file and no second database, while a hosted installation needs a
 * registry that several processes can write to. Everything above this interface
 * is identical in both cases - that is what keeps self-hosted and hosted on one
 * code path.
 */
export interface ControlPlane {
  readonly kind: 'file' | 'database'
  list(): Promise<TenantRecord[]>
  find(tenantId: string): Promise<TenantRecord | null>
  get(tenantId: string): Promise<TenantRecord>
  register(tenant: TenantRecordInput): Promise<TenantRecord>
  update(tenantId: string, changes: Partial<Omit<TenantRecordInput, 'id'>>): Promise<TenantRecord>
  remove(tenantId: string): Promise<void>
}

/** Shared `get` built on `find`, so implementations only provide the lookup. */
async function getOrThrow(plane: ControlPlane, tenantId: string): Promise<TenantRecord> {
  const tenant = await plane.find(tenantId)
  if (tenant === null) throw new TenantNotFoundError(tenantId)
  return tenant
}

/**
 * Control plane backed by a JSON file.
 *
 * Writes go through a temporary file and a rename so an interrupted
 * provisioning run cannot leave a half-written registry - losing the registry
 * would orphan every tenant database at once.
 */
export class FileControlPlane implements ControlPlane {
  readonly kind = 'file' as const

  constructor(private readonly filePath: string) {}

  private async read(): Promise<ControlPlaneFile> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { version: 1, tenants: [] }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new TenantConfigurationError(
        `Control plane file ${this.filePath} is not valid JSON: ${(error as Error).message}`,
      )
    }
    return parseControlPlaneFile(parsed)
  }

  private async write(document: ControlPlaneFile): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, this.filePath)
  }

  async list(): Promise<TenantRecord[]> {
    return (await this.read()).tenants
  }

  async find(tenantId: string): Promise<TenantRecord | null> {
    return (await this.read()).tenants.find((tenant) => tenant.id === tenantId) ?? null
  }

  async get(tenantId: string): Promise<TenantRecord> {
    return getOrThrow(this, tenantId)
  }

  async register(tenant: TenantRecordInput): Promise<TenantRecord> {
    const record = tenantRecordSchema.parse(tenant)
    const document = await this.read()
    if (document.tenants.some((existing) => existing.id === record.id)) {
      throw new TenantAlreadyExistsError(record.id)
    }
    await this.write({ ...document, tenants: [...document.tenants, record] })
    return record
  }

  async update(tenantId: string, changes: Partial<Omit<TenantRecord, 'id'>>): Promise<TenantRecord> {
    const document = await this.read()
    const index = document.tenants.findIndex((tenant) => tenant.id === tenantId)
    const existing = document.tenants[index]
    if (existing === undefined) throw new TenantNotFoundError(tenantId)

    const updated = tenantRecordSchema.parse({ ...existing, ...changes, id: tenantId })
    const tenants = [...document.tenants]
    tenants[index] = updated
    await this.write({ ...document, tenants })
    return updated
  }

  async remove(tenantId: string): Promise<void> {
    const document = await this.read()
    if (!document.tenants.some((tenant) => tenant.id === tenantId)) {
      throw new TenantNotFoundError(tenantId)
    }
    await this.write({
      ...document,
      tenants: document.tenants.filter((tenant) => tenant.id !== tenantId),
    })
  }

  get path(): string {
    return resolve(this.filePath)
  }

  get directory(): string {
    return dirname(resolve(this.filePath))
  }
}

/** Read-only view of a fixed list of tenants. Used by tests and by embedding. */
export class StaticControlPlane implements ControlPlane {
  readonly kind = 'file' as const
  private readonly tenants: TenantRecord[]

  constructor(tenants: readonly TenantRecordInput[]) {
    this.tenants = tenants.map((tenant) => tenantRecordSchema.parse(tenant))
  }

  async list(): Promise<TenantRecord[]> {
    return [...this.tenants]
  }

  async find(tenantId: string): Promise<TenantRecord | null> {
    return this.tenants.find((tenant) => tenant.id === tenantId) ?? null
  }

  async get(tenantId: string): Promise<TenantRecord> {
    return getOrThrow(this, tenantId)
  }

  async register(): Promise<TenantRecord> {
    throw new TenantConfigurationError('This control plane is read-only')
  }

  async update(): Promise<TenantRecord> {
    throw new TenantConfigurationError('This control plane is read-only')
  }

  async remove(): Promise<void> {
    throw new TenantConfigurationError('This control plane is read-only')
  }
}
