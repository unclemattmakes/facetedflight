// Types for tools/perf/worn-trace.mjs (DEV-993): the pure parts, for tests.
export declare const DEFAULT_URL: string
export declare const wornCategories: (lean: boolean) => string[]
export declare const grantPreferences: (origin: string) => {
  profile: { content_settings: { exceptions: { vr: Record<string, { setting: number }> } } }
}
export declare const withTraceParam: (url: string, seconds: number) => string
export interface WornArgs {
  url: string
  seconds: number
  out: string | null
  port: number
  chrome: string | null
  lean: boolean
  auto: number | null
  startNow: boolean
}
export declare const parseArgs: (argv: string[]) => WornArgs
export declare const main: (argv: string[]) => Promise<{ outDir: string; reduced: unknown }>
