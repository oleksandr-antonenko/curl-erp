export class ImportError extends Error {
  override name = 'ImportError'
}

/** Refuses to apply a proposal a second time, or one the catalog outgrew. */
export class ProposalNotApplicableError extends ImportError {
  override name = 'ProposalNotApplicableError'
  constructor(
    readonly state: string,
    message: string,
  ) {
    super(message)
  }
}
