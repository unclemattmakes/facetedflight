// src/render/hud-font.ts — the cockpit readout's typeface: CRYSTAL, 2016's own.
// DEV-362 follow-up.
//
// Matt, 2026-09-24: *"if you can - grab that old font."* It could be grabbed:
// `Assets/Faceted Flight/Fonts/CRYSTAL-Regular.ttf` is © 2014 Felipe Munoz
// under CC BY-SA 4.0, stated in its own name table and in the licence file
// beside it in the Unity project. Earlier rows (DEV-155, DEV-360, and
// HUD-REDESIGN §1.1) said it had no licence trail and could not ship; the trail
// was there, in the Unity project and inside the file. It ships UNMODIFIED from
// the content bucket (`assets/fonts/crystal-regular.ttf`, with its notice
// beside it) and is credited in THIRD-PARTY-NOTICES.md and README.md. Share-alike binds a
// modified copy of the FONT, so the file must never be subset or converted.
//
// ── How it reaches a canvas ──────────────────────────────────────────────────
//
// The panels are 2-D canvases, and a canvas does not wait for a font: a
// `fillText` in a family that has not loaded draws in the fallback and stays
// that way until something draws again. So:
//
//  1. `loadHudFont` starts at boot, through the FontFace API, before any world
//     is built — a 13 KB file that has normally landed long before the first
//     panel paints.
//  2. Every face-choosing function here asks `hudFontLoaded()` and names
//     CRYSTAL only once it is in `document.fonts`. Until then — and for good,
//     if the load fails — the panels draw in the stacks they always had.
//  3. `whenHudFontSettles` lets a panel that was built while the font was still
//     loading owe itself one repaint when it lands (`render/hud.ts`).
//
// The family is registered under its own name, `FF2 CRYSTAL`, so a copy a
// player happens to have installed under "CRYSTAL" can never stand in for the
// one the bucket serves.

/** The bucket key the font is served under. `tools/assets/required-assets.json`'s `font.crystal`. */
export const HUD_FONT_ASSET = 'assets/fonts/crystal-regular.ttf'

/** The family the FontFace is registered as. Not "CRYSTAL": see the header. */
export const HUD_FONT_FAMILY = 'FF2 CRYSTAL'

/**
 * DEV-883: characters CRYSTAL has a cmap entry for and draws wrongly. Its "?" is
 * a hairline glyph that reads as a P at the small note size ("NEW HERE?" was
 * photographed as "NEW HEREP"). The FontFace is registered with a
 * `unicode-range` that leaves these out, so the browser draws them from the
 * next family in the stack, as it already does for a character the file does
 * not hold at all (the file itself stays unmodified: share-alike binds a
 * modified copy). Add a character here when a photograph shows one misread.
 */
export const HUD_FONT_BAD_GLYPHS = '?'

/** The `unicode-range` descriptor: every code point except {@link HUD_FONT_BAD_GLYPHS}. */
export const hudFontUnicodeRange = (bad: string = HUD_FONT_BAD_GLYPHS): string => {
  const cut = [...bad].map((c) => c.codePointAt(0) ?? 0).sort((a, b) => a - b)
  const hex = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0')
  // CSS `unicode-range`: `U+0000-003D`, the second bound WITHOUT its own `U+`.
  const range = (lo: number, hi: number): string =>
    lo === hi ? `U+${hex(lo)}` : `U+${hex(lo)}-${hex(hi)}`
  const parts: string[] = []
  let from = 0
  for (const c of cut) {
    if (c > from) parts.push(range(from, c - 1))
    from = c + 1
  }
  parts.push(range(from, 0x10ffff))
  return parts.join(', ')
}

export type HudFontState = 'idle' | 'loading' | 'loaded' | 'failed'

let state: HudFontState = 'idle'
let settling: Promise<boolean> | null = null

/** Where the load is. `loaded` is the only state in which a panel names CRYSTAL. */
export const hudFontState = (): HudFontState => state

export const hudFontLoaded = (): boolean => state === 'loaded'

/** The FontFace API, structurally, so the unit suite can hand in a stand-in. */
export interface FontHost {
  readonly FontFace: new (
    family: string,
    source: string,
    descriptors?: FontFaceDescriptors,
  ) => { load(): Promise<unknown> }
  readonly fonts: { add(face: unknown): unknown }
}

const browserHost = (): FontHost | null => {
  const g = globalThis as unknown as {
    FontFace?: FontHost['FontFace']
    document?: { fonts?: FontHost['fonts'] }
  }
  return g.FontFace && g.document?.fonts ? { FontFace: g.FontFace, fonts: g.document.fonts } : null
}

/**
 * Start loading CRYSTAL from `url`. Idempotent: the first call wins and every
 * later one returns the same promise, which resolves `true` once the face is in
 * `document.fonts` and `false` if it could not be loaded — never rejects, so a
 * missing font can never take a boot down with it. A failure is logged once
 * and the panels keep their fallback stacks for the rest of the page.
 */
export const loadHudFont = (
  url: string,
  host: FontHost | null = browserHost(),
): Promise<boolean> => {
  if (settling) return settling
  if (!host) {
    state = 'failed'
    settling = Promise.resolve(false)
    return settling
  }
  state = 'loading'
  const face = new host.FontFace(HUD_FONT_FAMILY, `url(${JSON.stringify(url)})`, {
    style: 'normal',
    weight: '400',
    unicodeRange: hudFontUnicodeRange(),
  })
  settling = face.load().then(
    (loaded) => {
      host.fonts.add(loaded)
      state = 'loaded'
      return true
    },
    (err: unknown) => {
      state = 'failed'
      console.warn(
        `hud font: CRYSTAL did not load from ${url}; the panels keep their fallback`,
        err,
      )
      return false
    },
  )
  return settling
}

/**
 * Resolves once the CRYSTAL load has settled, `true` if it landed. Where no load
 * has started (a unit test, a boot that has not reached it) it resolves `false`
 * at once, so an `await` on it can never hang a boot (DEV-848).
 */
export const hudFontSettled = (): Promise<boolean> => settling ?? Promise.resolve(false)

/**
 * Run `repaint` once, when a load that is IN FLIGHT settles — whichever way it
 * goes, because a failure changes nothing on the panel and a repaint of the
 * same pixels is harmless. Nothing happens if no load is in flight: a panel
 * built after the font landed already draws in it, and one built where it will
 * never load has nothing to wait for.
 */
export const whenHudFontSettles = (repaint: () => void): void => {
  if (state !== 'loading' || !settling) return
  void settling.then(() => repaint())
}

/**
 * The CSS font for a panel's text at `px`: CRYSTAL once it has loaded, else
 * `fallback(px)`. CRYSTAL is one weight, Regular — 2016 drew it at
 * `m_FontStyle` 0 — so it is named at 400 and never synthesised bold. The
 * fallback stack follows it for any glyph CRYSTAL lacks.
 */
export const hudFace = (px: number, fallback: (px: number) => string): string => {
  const size = Math.max(1, Math.round(px))
  if (!hudFontLoaded()) return fallback(size)
  return `400 ${size}px "${HUD_FONT_FAMILY}", "Bahnschrift", "Segoe UI", ui-sans-serif, system-ui, sans-serif`
}

/** Test seam: forget the load, so each unit test starts from `idle`. */
export const resetHudFontForTests = (): void => {
  state = 'idle'
  settling = null
}
