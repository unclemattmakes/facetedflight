// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/net/http.ts: the web platform's streams, as the net layer reads them.
//
// One byte-capped reader, where there were six (code-reuse audit BE-8 / XC-8,
// 2026-10-05): `lap-server.ts` and `room-lap.ts` each read a request body;
// `lap-client.ts`, `content/player-course-wire.ts` and `content/island-map.ts`
// each drained a stream; `lap-validate.ts` inlined the loop. The copies had
// drifted (DEV-675: one had lost its `.catch`), which is the reason to have
// one.
//
// SERVER-SAFE and PAGE-SAFE: web platform only (`ReadableStream`, `Request`,
// `TextDecoder`), which a Worker, node 24 and a browser all have. No imports,
// so the rooms Worker's bundle and `functions/` can both reach it, and so
// `src/content` can import it without a layering loop (content already
// imports `@/net/base64url`).

/**
 * Collect a byte stream, refusing it WHILE reading once it passes `cap` bytes:
 * the stream is cancelled and null comes back. Reading first to measure is
 * the thing a cap exists to prevent (a 64 KB zip bomb is ~66 MB of zeros).
 *
 * The cancel's own rejection is swallowed: the source may throw from its
 * `cancel`, or the connection may be gone, and the refusal is the answer
 * either way (DEV-675). A read error is NOT swallowed: it is the caller's to
 * classify (`lap-validate.ts` calls it "not raw deflate").
 *
 * Memory is bounded by what arrived, never by `cap`: a caller with a large
 * cap pays for the bytes it got, not for the bytes it would have refused.
 */
export const drainCapped = async (
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<Uint8Array | null> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/**
 * The request body as text, or null past `cap` BYTES. A `Content-Length` that
 * admits to being over the cap is refused before a byte is read; one that is
 * absent or lies is caught by `drainCapped` while reading. A request with no
 * body is the empty string.
 */
export const readCapped = async (request: Request, cap: number): Promise<string | null> => {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > cap) return null
  if (!request.body) return ''
  const bytes = await drainCapped(request.body, cap)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

// ── Responses ─────────────────────────────────────────────────────────────

/**
 * A JSON response that no cache keeps and no browser sniffs (BE-7: the lap
 * server's, which `room-lap` rewrote byte for byte and `stats-server`
 * inlined). A caller whose answer IS cacheable passes its own `cache-control`:
 * the spread comes last, so it wins.
 */
export const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      ...headers,
    },
  })

/** `{ error, reason }` at `status`: the refusal every lap endpoint answers in. */
export const refuse = (
  status: number,
  error: string,
  reason: string,
  headers?: Record<string, string>,
) => json(status, { error, reason }, headers)
