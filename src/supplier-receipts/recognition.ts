/*
 * Reading a document, by something the core does not know.
 *
 * The core declares this shape and nothing else. No model, no service, no
 * credential and no vendor name appears here or anywhere below it: an
 * implementation is installed by a deployment, and the core must run with none
 * installed at all. That is not only a licensing boundary - it is what forces
 * every path to work when a scan is unreadable, which is the path a person
 * walks on a bad fax.
 *
 * What comes back is a proposal. Core rule: a machine produces a draft and a
 * person publishes it. So nothing here is allowed to resolve a line to a
 * catalog variant, and nothing here is treated as accepted.
 */

/** One line as the recogniser read it off the paper. */
export interface RecognisedLine {
  /** The description as printed, untranslated and uncorrected. */
  readonly name: string
  readonly unit?: string
  readonly quantity: number
  /** This line's amount, integer minor units. */
  readonly amountMinor?: number
  /** The per-unit figure as printed, integer minor units, when there is one. */
  readonly unitPriceMinor?: number
}

/** What the recogniser made of a supplier's document. */
export interface RecognisedInvoice {
  readonly number?: string
  /** The document's own date, as printed. */
  readonly documentDate?: string
  readonly supplierName?: string
  readonly supplierRegistryCode?: string
  readonly buyerName?: string
  readonly currency?: string
  readonly totalMinor?: number
  readonly vatMinor?: number
  readonly lines: readonly RecognisedLine[]
  /**
   * What it could not read, in words a person can act on.
   *
   * Deliberately not an error: a document with one unreadable line is still
   * worth nine readable ones, and hiding the gap is how a wrong number gets
   * posted.
   */
  readonly problems: readonly string[]
}

/**
 * Something that can read a stored document.
 *
 * Takes the content, not a path: where the bytes live is the document store's
 * business, and an implementation that needs them on a disk somewhere can
 * arrange that itself without the core knowing.
 */
export interface InvoiceRecogniser {
  read(input: {
    readonly content: Uint8Array
    readonly mediaType: string
    readonly fileName?: string
  }): Promise<RecognisedInvoice>
}

/** No recogniser is installed, so this document has to be typed in. */
export class RecognitionUnavailableError extends Error {
  override readonly name = 'RecognitionUnavailableError'
  constructor() {
    super('No recogniser is configured; the document has to be completed by hand')
  }
}
