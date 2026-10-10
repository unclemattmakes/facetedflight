export interface ManifestAsset {
  id: string
  path: string
  kind: string
  state: string
  licence: string
  share?: string
  shareWhy?: string
  shareAuthor?: string
  shareModified?: boolean
  source?: string
  sha256?: string
  bytes?: number
  [key: string]: unknown
}
export const REPO_ROOT: string
export const MANIFEST_PATH: string
export const LICENCE_TEXT_DIR: string
export const SHARE_LICENCES: Record<string, { name: string; url: string }>
export const NEVER_SHARE_PROVENANCE: RegExp
export function packVersion(): string
export function packFileName(version?: string): string
export function loadAssetManifest(file?: string): { assets: ManifestAsset[] }
export function geometrySource(a: { source?: string }): string
export function shareProblems(assets: ManifestAsset[]): string[]
export function sharedAssets(assets: ManifestAsset[]): ManifestAsset[]
export function sha256Hex(buf: Buffer): string
export function safePackPath(p: unknown): boolean
export function writeZip(entries: { name: string; data: Buffer }[]): Buffer
export function readZip(buf: Buffer): Map<string, Buffer>
