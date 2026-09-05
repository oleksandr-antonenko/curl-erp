import type { SalesChannelAdapter } from './contract.js'

export interface ChannelConfiguration {
  /** Stable channel id, used in mappings and queues. */
  readonly id: string
  /** Module to load the adapter from, e.g. `@erp/channel-storefront`. */
  readonly resolve: string
  readonly options?: Readonly<Record<string, unknown>>
  readonly enabled?: boolean
}

export type ChannelAvailability = 'ready' | 'not_installed' | 'failed' | 'disabled'

export interface ChannelStatus {
  readonly id: string
  readonly availability: ChannelAvailability
  readonly reason?: string
}

/** Shape an adapter package must export. */
export interface ChannelAdapterModule {
  createChannelAdapter(options: Readonly<Record<string, unknown>>): SalesChannelAdapter
}

export class ChannelNotAvailableError extends Error {
  override readonly name = 'ChannelNotAvailableError'
  constructor(
    readonly channelId: string,
    reason: string,
  ) {
    super(`Channel "${channelId}" is not available: ${reason}`)
  }
}

/**
 * The channels this installation actually has.
 *
 * Adapters are loaded from configuration, never imported by the core: the core
 * is given away and the adapters are sold, so a missing adapter has to be a
 * normal state rather than a crash. Everything else keeps working; only the
 * things that need that channel are unavailable.
 */
export class ChannelRegistry {
  private readonly adapters = new Map<string, SalesChannelAdapter>()
  private readonly statuses = new Map<string, ChannelStatus>()

  /** Registers an already-constructed adapter. */
  register(adapter: SalesChannelAdapter): void {
    this.adapters.set(adapter.id, adapter)
    this.statuses.set(adapter.id, { id: adapter.id, availability: 'ready' })
  }

  /**
   * Loads what configuration asks for, recording rather than throwing when an
   * adapter is absent or refuses to start.
   */
  async load(
    configurations: readonly ChannelConfiguration[],
    importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
  ): Promise<readonly ChannelStatus[]> {
    for (const configuration of configurations) {
      if (configuration.enabled === false) {
        this.statuses.set(configuration.id, {
          id: configuration.id,
          availability: 'disabled',
        })
        continue
      }

      try {
        const loaded = (await importModule(configuration.resolve)) as Partial<ChannelAdapterModule>
        if (typeof loaded.createChannelAdapter !== 'function') {
          this.statuses.set(configuration.id, {
            id: configuration.id,
            availability: 'failed',
            reason: `${configuration.resolve} does not export createChannelAdapter`,
          })
          continue
        }

        const adapter = loaded.createChannelAdapter(configuration.options ?? {})
        await adapter.connect?.()
        this.adapters.set(configuration.id, adapter)
        this.statuses.set(configuration.id, { id: configuration.id, availability: 'ready' })
      } catch (error) {
        const message = (error as Error).message
        const notInstalled = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(message)
        this.statuses.set(configuration.id, {
          id: configuration.id,
          availability: notInstalled ? 'not_installed' : 'failed',
          reason: message,
        })
      }
    }
    return this.statusList()
  }

  get ids(): readonly string[] {
    return [...this.adapters.keys()]
  }

  get size(): number {
    return this.adapters.size
  }

  find(channelId: string): SalesChannelAdapter | null {
    return this.adapters.get(channelId) ?? null
  }

  /** The adapter, or an explanation of why there is none. */
  get(channelId: string): SalesChannelAdapter {
    const adapter = this.adapters.get(channelId)
    if (adapter !== undefined) return adapter
    const status = this.statuses.get(channelId)
    throw new ChannelNotAvailableError(
      channelId,
      status?.reason ?? status?.availability ?? 'no such channel is configured',
    )
  }

  all(): readonly SalesChannelAdapter[] {
    return [...this.adapters.values()]
  }

  statusList(): readonly ChannelStatus[] {
    return [...this.statuses.values()]
  }

  async close(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.close?.()
    this.adapters.clear()
  }
}

/** Reads channel configuration from an environment variable holding JSON. */
export function channelConfigurationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): readonly ChannelConfiguration[] {
  const raw = env['CHANNELS']
  if (raw === undefined || raw.trim() === '') return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error('CHANNELS must be a JSON array')
  return parsed as ChannelConfiguration[]
}
