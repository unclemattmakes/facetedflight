// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/net/digest.ts: SHA-256 through `crypto.subtle`, as the net layer, the
// content layer and the editor each wrote it (code-reuse audit BE-3).
//
// ASYNC, and the name says so: `content/sha256.ts` is the SYNCHRONOUS pure
// implementation (`sha256Hex(bytes): string`), deliberately sync so
// `expandPlayerCourse` stays synchronous. It used to share a NAME with the
// lap server's async text hash; this file's are `sha256Bytes` and
// `sha256HexAsync`, so a reader can tell which they have.
//
// STORED IDENTIFIERS: the lap server's owner hash and address hash come out of
// `sha256HexAsync`, lower-case hex of the UTF-8 digest. Change a byte of this
// and every stored hash is orphaned. `tests/unit/digest.test.ts` pins known
// vectors.
//
// SERVER-SAFE and page-safe: `crypto.subtle` and `TextEncoder` are in a
// Worker, node 24 and a browser (a page over plain HTTP has no `subtle`:
// callers that run there check for it themselves).

/** The SHA-256 digest of a string (as UTF-8) or of bytes. */
export const sha256Bytes = async (data: string | Uint8Array): Promise<Uint8Array> => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** Bytes as lower-case hex, two digits each. */
export const hexOfBytes = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** The SHA-256 of a string or bytes, lower-case hex (64 characters). */
export const sha256HexAsync = async (data: string | Uint8Array): Promise<string> =>
  hexOfBytes(await sha256Bytes(data))
