// src/net/pages-function.ts — the shape of a Cloudflare Pages Function. DEV-372.
//
// The slice of `@cloudflare/workers-types`' `PagesFunction` that `functions/`
// uses, written out rather than installed: one type does not justify a
// dependency (every upgrade lands alone, CLAUDE.md), and the web-platform types
// it rests on — `Request`, `Response`, `crypto` — are already in this
// project's `lib`. A Pages Function receives one context object; it returns a
// `Response`.

export interface PagesContext<Env, Params extends string = never> {
  readonly request: Request
  readonly env: Env
  readonly params: Readonly<Record<Params, string | string[]>>
  waitUntil(promise: Promise<unknown>): void
  next(): Promise<Response>
}

export type PagesFunction<Env = unknown, Params extends string = never> = (
  context: PagesContext<Env, Params>,
) => Response | Promise<Response>
