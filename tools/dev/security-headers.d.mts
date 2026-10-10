import type { Plugin } from 'vite'

export const HEADERS_FILE: string
export const SECURITY_HEADERS: Readonly<Record<string, string>>
export function headersFile(): string
export function securityHeaders(): Plugin
