// src/boot/version.ts — the build version, rendered on the landing page AND in
// the cockpit. Invaluable when a bug report arrives from inside a headset and
// the reporter cannot see a URL bar.

import pkg from '../../package.json'

export const BUILD_VERSION = `v${pkg.version}`

/** Set at build time by Vite; `dev` when running the dev server. */
export const BUILD_MODE: string = import.meta.env.MODE
