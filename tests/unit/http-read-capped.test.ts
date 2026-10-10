// tests/unit/http-read-capped.test.ts: the one byte-capped reader the net
// layer and content share (code-reuse audit BE-8 / XC-8).
//
// Six copies became `src/net/http.ts`; these pin what every copy promised:
// refused WHILE reading (a lying or absent Content-Length is caught by the
// bytes), a cancel that rejects is swallowed (DEV-675), the cap is inclusive,
// an empty body is the empty string, and the count is in BYTES.

import { describe, expect, it } from 'vitest'
import { drainCapped, readCapped } from '@/net/http'

const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> => {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++] as Uint8Array)
      else controller.close()
    },
  })
}

const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill)

describe('drainCapped', () => {
  it('collects every chunk, in order, up to and including the cap', async () => {
    const out = await drainCapped(streamOf([bytes(3, 1), bytes(2, 2), bytes(1, 3)]), 6)
    expect(out).not.toBeNull()
    expect([...(out as Uint8Array)]).toEqual([1, 1, 1, 2, 2, 3])
  })

  it('refuses one byte past the cap, and cancels the source there', async () => {
    let cancelled = false
    let pulled = 0
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(bytes(4))
      },
      cancel() {
        cancelled = true
      },
    })
    expect(await drainCapped(source, 7)).toBeNull()
    expect(cancelled).toBe(true)
    // Two pulls reach 8 > 7; an endless source was not read to its end.
    expect(pulled).toBeLessThanOrEqual(3)
  })

  it('swallows a cancel that rejects (DEV-675)', async () => {
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes(10))
      },
      cancel() {
        throw new Error('would not cancel')
      },
    })
    await expect(drainCapped(source, 5)).resolves.toBeNull()
  })

  it('lets a read error through for the caller to classify', async () => {
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('not deflate')
      },
    })
    await expect(drainCapped(source, 5)).rejects.toThrow('not deflate')
  })

  it('is the empty array for an empty stream', async () => {
    expect([...((await drainCapped(streamOf([]), 5)) as Uint8Array)]).toEqual([])
  })
})

describe('readCapped', () => {
  const post = (
    body: string | ReadableStream<Uint8Array>,
    headers: Record<string, string> = {},
  ): Request =>
    new Request('https://site/api', {
      method: 'POST',
      body,
      headers,
      // A streamed request body is half-duplex by the fetch spec; node insists.
      ...(typeof body === 'string' ? {} : { duplex: 'half' }),
    } as RequestInit)

  it('decodes a body under the cap as text', async () => {
    expect(await readCapped(post('hello'), 5)).toBe('hello')
  })

  it('is the empty string for a request with no body', async () => {
    expect(await readCapped(new Request('https://site/api'), 5)).toBe('')
  })

  it('refuses a Content-Length that admits to being over the cap without reading', async () => {
    // `Request` prefetches a chunk from a stream body on construction, so a
    // pull count cannot tell; `bodyUsed` is whether anybody READ it.
    const request = post(streamOf([bytes(1)]), { 'content-length': '999' })
    expect(await readCapped(request, 5)).toBeNull()
    expect(request.bodyUsed).toBe(false)
  })

  it('refuses a body whose Content-Length lies small, by its bytes', async () => {
    expect(await readCapped(post(streamOf([bytes(6)]), { 'content-length': '1' }), 5)).toBeNull()
  })

  it('counts BYTES, not characters: a multibyte body past the cap is refused', async () => {
    // Three bytes a character: six characters are 18 bytes, over a cap of 16.
    expect(await readCapped(post('€€€€€€'), 16)).toBeNull()
    expect(await readCapped(post('€€€€€'), 16)).toBe('€€€€€')
  })
})
