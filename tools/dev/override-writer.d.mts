// Type declarations for override-writer.mjs (DEV-539).
//
// The plugin stays plain JavaScript beside the other tools, and this gives the
// TypeScript side — `vite.config.ts` and the two node tests — real types. Same
// convention as `tools/perf/png-diff.d.mts`.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

export declare const OVERRIDE_ROUTE: '/__ff2/override/'
/** DEV-540: the swallow record, read-only. */
export declare const OVERRIDE_HMR_ROUTE: '/__ff2/override-hmr'
export declare const MAX_BODY_BYTES: number

/** The part of `src/content/level-override.ts` the handler calls. */
export interface OverrideValidator {
  validateOverride: typeof import('../../src/content/level-override').validateOverride
  checkOverride: typeof import('../../src/content/level-override').checkOverride
  applyOverride: typeof import('../../src/content/level-override').applyOverride
  canonicalOverrideText: typeof import('../../src/content/level-override').canonicalOverrideText
  baseProblem: typeof import('../../src/content/level-override').baseProblem
}

export declare const generatedIds: (root: string) => string[]

/** DEV-544: the artefact a course-moving Save rebuilds, relative to the root. */
export declare const LAP_COURSES_PATH: 'content/lap-courses.json'

/** The part of `src/net/lap-courses-text.ts` a Save calls (DEV-544). */
export interface LapCoursesBuilder {
  lapCoursesTextFrom: typeof import('../../src/net/lap-courses-text').lapCoursesTextFrom
}

/** DEV-544: the lap courses as they must read once `id`'s override is `next` (null: none). */
export declare const plannedLapCourses: (options: {
  root: string
  builder: LapCoursesBuilder | Record<string, unknown>
  id: string
  next: unknown
}) => Promise<{ file: string; text: string; changed: boolean }>

export declare const createOverrideHandler: (options: {
  root: string
  loadValidator: () => Promise<OverrideValidator | Record<string, unknown>>
  /** DEV-544: the lap courses' builder; absent, a Save writes the override alone. */
  loadLapBuilder?: (() => Promise<LapCoursesBuilder | Record<string, unknown>>) | null
  onWrite?: (file: string, text: string) => void
  /** DEV-540: told before the DELETE route removes a file. */
  onDelete?: (file: string) => void
}) => (req: IncomingMessage, res: ServerResponse, next?: () => void) => Promise<void>

/** One hot update the plugin swallowed. */
export interface SwallowedUpdate {
  readonly environment: string
  readonly type: 'create' | 'update' | 'delete'
  readonly file: string
  /** `Date.now()` when it was swallowed. */
  readonly at: number
}

export declare const overrideWriter: (options?: {
  validator?: string
  /** DEV-544: the lap courses' builder module; null, a Save writes the override alone. */
  lapBuilder?: string | null
}) => Omit<Plugin, 'api'> & {
  readonly api: { readonly swallowed: readonly SwallowedUpdate[] }
}
