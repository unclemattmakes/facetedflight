// tests/unit/do-link.test.ts: the Durable Object links' shared verbs (code-reuse
// audit BE-17). Three files wrote the post-JSON client, the "field or null"
// read and the body-less answers; the links' own tests pin the routes.

import { describe, expect, it } from 'vitest'
import { fieldOrNull, noBody, postJson, takenOr409 } from '@/net/do-link'

describe('postJson', () => {
  it('sends a JSON POST through the stub and returns its answer', async () => {
    let seen: Request | null = null
    const answer = new Response(null, { status: 204 })
    const r = await postJson(
      async (request) => {
        seen = request
        return answer
      },
      'https://rooms/internal/verdict',
      { slot: 2 },
    )
    expect(r).toBe(answer)
    const sent = seen as unknown as Request
    expect(sent.method).toBe('POST')
    expect(sent.url).toBe('https://rooms/internal/verdict')
    expect(sent.headers.get('content-type')).toBe('application/json')
    expect(await sent.json()).toEqual({ slot: 2 })
  })
})

describe('fieldOrNull', () => {
  it('is the named field of an OK answer and null for anything else', async () => {
    expect(await fieldOrNull<string>(Response.json({ tv: 'tv_x' }), 'tv')).toBe('tv_x')
    expect(await fieldOrNull<string>(new Response(null, { status: 404 }), 'tv')).toBeNull()
  })
})

describe('noBody and takenOr409', () => {
  it('answer with a status and nothing else', async () => {
    const r = noBody(404)
    expect(r.status).toBe(404)
    expect(await r.text()).toBe('')
    expect(takenOr409(true).status).toBe(204)
    expect(takenOr409(false).status).toBe(409)
  })
})
