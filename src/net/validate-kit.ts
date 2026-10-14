// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/net/validate-kit.ts: what every hand-written validator in the port
// needs and was writing for itself (code-reuse audit BE-13 / XC-25).
//
// WHY IN `net/`: it is the lowest layer that has any validators. `content`
// already imports `@/net/base64url` and `@/net/http`; `net/room-protocol.ts`
// parses untrusted socket frames and must not pull `content` into the rooms
// Worker's bundle. Pure, DOM-free, three-free, no imports.

/** A plain object: not null, not an array. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A short, safe rendering of something hostile, for an error message. NEVER
 * THROWS: `JSON.stringify` throws on a cycle and on a BigInt, and a validator
 * that throws from inside its own error path has turned a refusal into a crash
 * (DEV-677: `content/level-override.ts` called it bare). A value that cannot
 * be written is named by its type.
 *
 * Text longer than `max` is cut to `keep` characters (default `max`) and
 * `ellipsis` appended. The two callers differ and their messages are pinned:
 * one cuts at 64 and keeps 64; the other cuts at 24 and keeps 21.
 */
export const shownValue = (
  v: unknown,
  max: number,
  ellipsis: string,
  keep: number = max,
): string => {
  let text: string
  try {
    text = JSON.stringify(v) ?? String(v)
  } catch {
    text = typeof v
  }
  return text.length > max ? `${text.slice(0, keep)}${ellipsis}` : text
}

/**
 * A validator's accumulating list of `[path, message]`, capped: a hostile
 * document with ten thousand faults is told about the first `cap` of them.
 * `content/level-override.ts` and `content/player-course.ts` each extend it
 * with their own cap and issue type.
 */
export class IssueList<Issue extends readonly [path: string, message: string]> {
  readonly list: Issue[] = []
  constructor(private readonly cap: number) {}
  add(path: string, message: string): void {
    if (this.list.length < this.cap) this.list.push([path, message] as unknown as Issue)
  }
  get any(): boolean {
    return this.list.length > 0
  }
}
