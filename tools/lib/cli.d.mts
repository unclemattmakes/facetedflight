// Type declarations for cli.mjs. See legacy-root.d.mts for why these are separate.

/** True when the module at `importMetaUrl` is the script node was started with. */
export declare const isMain: (importMetaUrl: string) => boolean

/** The value after `--name` on the command line, or `fallback` when absent or last. */
export declare const flag: <T>(name: string, fallback: T) => string | T
