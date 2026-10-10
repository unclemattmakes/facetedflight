// Type declarations for ssr.mjs. See legacy-root.d.mts for why these are separate.

import type { ViteDevServer } from 'vite'

/** A Vite middleware-mode server rooted at the repository; the caller must `close()` it. */
export declare const createSsrServer: (opts?: {
  logLevel?: 'info' | 'warn' | 'error' | 'silent'
}) => Promise<ViteDevServer>

/** `path` from the repository root (`/src/...`), loaded by Vite's SSR loader on a shared server. */
export declare const ssrImport: <T>(path: string) => Promise<T>

/** Close the shared loader, if one was started. */
export declare const closeSsr: () => Promise<void>
