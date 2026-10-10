export interface SecretFinding {
  readonly file: string
  readonly line: number
  readonly name: string
}
export interface SinkHit {
  readonly file: string
  readonly line: number
  readonly text: string
}
export interface SinkAllow {
  readonly file: string
  readonly line: string
  readonly why: string
}
export const SECRET_PATTERNS: readonly (readonly [string, RegExp])[]
export const SECRET_FILE_NAMES: RegExp
export const SECRET_ALLOW: readonly {
  readonly path: RegExp
  readonly name: string
  readonly why: string
}[]
export function scanSecrets(file: string, text: string): SecretFinding[]
export const SINK_PATTERN: RegExp
export const SINK_ALLOW: readonly SinkAllow[]
export const SINK_ROOTS: readonly string[]
export function scanSinks(file: string, text: string): SinkHit[]
export function judgeSinks(hits: readonly SinkHit[]): { unallowed: SinkHit[]; stale: SinkAllow[] }
export function trackedFiles(root?: string): string[]
export function secretsInTree(root?: string): SecretFinding[]
export function sinksInTree(root?: string): { unallowed: SinkHit[]; stale: SinkAllow[] }
export function missingHeaders(distDir: string): string[] | null
