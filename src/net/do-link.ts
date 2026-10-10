// src/net/do-link.ts: the plumbing of a Durable Object's internal API
// (code-reuse audit BE-17): the post-JSON client and the body-less answers
// that `room-link.ts`, `room-directory.ts` and `tv-guide.ts` each wrote for
// themselves.
//
// Each link keeps what is its own: its URL table, its parser, its answers.
// This file is only the shared verbs. Binding-only traffic (the Worker calls
// the object's stub; nothing outside can reach it), so the bodies stay as
// loosely read as they always were: a body that does not parse is a 400 at the
// caller's `catch`, a body that parses to the wrong shape is the parser's.
//
// SERVER-SAFE: web platform only.

/** A stub's `fetch`, with whatever header the object's name needs already carried. */
export type LinkFetch = (request: Request) => Promise<Response>

/** `POST` a JSON body to an internal URL. */
export const postJson = (fetchLink: LinkFetch, url: string, body: unknown): Promise<Response> =>
  fetchLink(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

/** One field of a JSON answer, or null when the object did not say OK. */
export const fieldOrNull = async <T>(response: Response, field: string): Promise<T | null> =>
  response.ok ? (((await response.json()) as Record<string, unknown>)[field] as T) : null

/** An answer with a status and no body. */
export const noBody = (status: number): Response => new Response(null, { status })

/** 204 when the object took it, 409 when it refused. */
export const takenOr409 = (taken: boolean): Response => noBody(taken ? 204 : 409)
