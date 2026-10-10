// src/net/fetch-json.ts: the client's half of "ask the server, read JSON or
// nothing" (code-reuse audit BE-16).
//
// `lap-client.ts` read a body to an object-or-null and mapped a network
// failure; `game/tv/tv-view.ts` and `game/tv/watch-me.ts` each built
// `{ status, body }` by hand. One home, DOM-free: the caller passes `fetch`,
// as `lap-client` always did, so a test hands in a fake.
//
// Never throws: a body that is not JSON is `null`, a fetch that rejects is
// `null`. What a null MEANS stays the caller's (a refusal, a retry, an idle
// panel); this file only refuses to turn a bad answer into an exception.

/** A response body as JSON, or null when it is not JSON (or is the word null). */
export const readJsonBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** A response body as a JSON OBJECT, or null: an array or a scalar is not one. */
export const readJsonObject = async (
  response: Response,
): Promise<Record<string, unknown> | null> => {
  const body = await readJsonBody(response)
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null
}

/** What a poller reads of an answer: the status, and the body if it was JSON. */
export const answerOf = async (
  response: Response,
): Promise<{ readonly status: number; readonly body: unknown }> => ({
  status: response.status,
  body: await readJsonBody(response),
})

/** The response, or null when the request could not be made at all (offline, blocked). */
export const fetchOrNull = async (
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init?: RequestInit,
): Promise<Response | null> => {
  try {
    return await fetchFn(url, init)
  } catch {
    return null
  }
}
