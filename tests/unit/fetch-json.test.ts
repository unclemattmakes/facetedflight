// tests/unit/fetch-json.test.ts: the client's "JSON or nothing" reads (code-reuse
// audit BE-16). `lap-client`'s private pair and two hand-built `{ status, body }`
// became these; every caller depends on none of them throwing.

import { describe, expect, it } from 'vitest'
import { answerOf, fetchOrNull, readJsonBody, readJsonObject } from '@/net/fetch-json'

const reply = (body: string, status = 200): Response => new Response(body, { status })

describe('readJsonBody', () => {
  it('is the parsed body, or null when it is not JSON', async () => {
    expect(await readJsonBody(reply('{"a":1}'))).toEqual({ a: 1 })
    expect(await readJsonBody(reply('[1]'))).toEqual([1])
    expect(await readJsonBody(reply('<html>'))).toBeNull()
    expect(await readJsonBody(reply(''))).toBeNull()
  })

  it('does not throw when the body cannot even be read', async () => {
    const broken = { json: () => Promise.reject(new Error('socket closed')) } as unknown as Response
    const thrower = {
      json: () => {
        throw new Error('sync')
      },
    } as unknown as Response
    expect(await readJsonBody(broken)).toBeNull()
    expect(await readJsonBody(thrower)).toBeNull()
  })
})

describe('readJsonObject', () => {
  it('is an object or null: an array, a scalar and the word null are none', async () => {
    expect(await readJsonObject(reply('{"error":"x"}'))).toEqual({ error: 'x' })
    expect(await readJsonObject(reply('null'))).toBeNull()
    expect(await readJsonObject(reply('7'))).toBeNull()
    expect(await readJsonObject(reply('"s"'))).toBeNull()
    // Arrays are objects to `typeof`; lap-client's read always let them through.
    expect(await readJsonObject(reply('[1]'))).toEqual([1])
  })
})

describe('answerOf', () => {
  it('is the status and the body, with the body null when it is not JSON', async () => {
    expect(await answerOf(reply('{"races":[]}', 200))).toEqual({ status: 200, body: { races: [] } })
    expect(await answerOf(reply('nope', 503))).toEqual({ status: 503, body: null })
  })
})

describe('fetchOrNull', () => {
  it('is the response, or null when the request could not be made', async () => {
    const ok = reply('x')
    expect(await fetchOrNull(async () => ok, '/a')).toBe(ok)
    expect(
      await fetchOrNull(async () => {
        throw new TypeError('Failed to fetch')
      }, '/a'),
    ).toBeNull()
  })
})
