/*
 * Where the bytes live.
 *
 * An interface, because a deployment decides this: a directory on the host, a
 * mounted volume, an object store. The core stores the location it was given
 * and never builds a path of its own, so nothing here assumes a filesystem.
 */
export interface DocumentStore {
  /**
   * Writes content and returns the location by which it can be read back.
   * Called only when the content is not already stored.
   */
  put(input: {
    readonly contentHash: string
    readonly content: Uint8Array
    readonly mediaType: string
  }): Promise<string>

  /** Reads content back. Throws if the location holds nothing. */
  get(location: string): Promise<Uint8Array>
}

export class DocumentStoreError extends Error {
  override readonly name = 'DocumentStoreError'
}
