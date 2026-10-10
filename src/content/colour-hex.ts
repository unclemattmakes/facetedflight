// src/content/colour-hex.ts: sRGB 0..1 <-> `#rrggbb`, once (code-reuse audit
// WP-3, crosscut.md XC-4 / boot-editor-content-net.md BE-4). Pure: no three, no
// DOM, so the editor desk, the look-dev panel and the racer liveries can all
// import it without a layer argument. Three copies of each direction existed.

/**
 * An sRGB 0..1 colour as `#rrggbb`, which is what `<input type=color>`, a canvas
 * `fillStyle` and a console line all read. Clamped, so a value past 1 is white
 * rather than garbage; only the first three channels are read, so an RGBA
 * tuple writes its colour and drops its alpha.
 */
export const srgbToHex = (c: readonly number[]): string =>
  `#${c
    .slice(0, 3)
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/**
 * `#rrggbb` to sRGB 0..1, {@link srgbToHex} backwards. Tolerates a missing `#`
 * (the editor's tint field and a hand-authored lesson colour both reach it).
 */
export const hexToSrgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
