import type { StockSource } from '../channels/stock.js'

/** A stock source held in memory, until the inventory capability provides one. */
export class InMemoryStock implements StockSource {
  private readonly levels = new Map<string, number>()

  constructor(initial: Readonly<Record<string, number>> = {}) {
    for (const [variantLocalId, available] of Object.entries(initial)) {
      this.levels.set(variantLocalId, available)
    }
  }

  set(variantLocalId: string, available: number): void {
    this.levels.set(variantLocalId, available)
  }

  async availableFor(variantLocalIds: readonly string[]): Promise<Map<string, number>> {
    return new Map(variantLocalIds.map((id) => [id, this.levels.get(id) ?? 0]))
  }
}
