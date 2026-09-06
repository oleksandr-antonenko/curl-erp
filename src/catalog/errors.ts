export class CatalogError extends Error {
  override readonly name = 'CatalogError'
}

/** A SKU, barcode or slug already belongs to something else. */
export class DuplicateIdentifierError extends CatalogError {
  constructor(
    readonly field: string,
    readonly value: string,
    readonly heldBy: string,
  ) {
    super(`${field} "${value}" already belongs to ${heldBy}`)
  }
}

export class NotFoundError extends CatalogError {
  constructor(what: string, id: string) {
    super(`No ${what} with id ${id}`)
  }
}
