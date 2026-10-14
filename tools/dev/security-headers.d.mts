import type { Plugin } from 'vite'

export const HEADERS_FILE: string
export const SECURITY_HEADERS: Readonly<Record<string, string>>
export const HASHED_PREFIX: string
export const IMMUTABLE_CACHE: string
export const HASHED_ASSET: RegExp
export function headersFile(options?: { immutableAssets?: boolean }): string
export function unhashedUnderAssets(fileNames: string[]): string[]
export function securityHeaders(options?: { immutableAssets?: boolean }): Plugin
