// src/boot/lookdev.ts — tune the look while the game is running.
//
// Matt: *"stub out an in-game lookdev menu where i can tune tweakable settings
// in realtime."*
//
// Every art number in this port has so far been found the same way: change a
// constant, `pnpm check`, drive a screenshot spec, look, repeat. That loop is
// about ninety seconds and it is the reason the fog has been retuned three
// times and the clouds twice. A slider is the same decision in a second, and —
// the part that matters — it ends with a NUMBER rather than a feeling.
//
// ── What this is not ─────────────────────────────────────────────────────
//
// It is not a settings menu and it is not shipped. `?lookdev=1` builds it,
// nothing else does, and it lives in the DOM rather than in the scene, which
// means it is a FLAT-SCREEN tool: `dom-overlay` is not reliably granted on
// Quest (CLAUDE.md), so in a headset there is nothing to see. Tune on the
// monitor, fly in the headset.
//
// It also does not persist. Values go back to the constants on reload, on
// purpose: a tool that quietly remembers a setting is a tool that makes the
// build behave differently for one person, and this project has already lost a
// day to a number that was true in one place and not another. The ONE
// exception is a group with a `storageKey` — the Placement folder (DEV-129) —
// and `LookdevGroup.storageKey` says what keeps it honest: only the panel
// reads the key, and the group has a Reset button.
//
// ── The contract that makes it useful ────────────────────────────────────
//
// Every control ends at **Copy settings**, which puts the current values on the
// clipboard as the source lines that would bake them in. The loop is: drag,
// look, copy, paste into chat. Nothing here writes to a file, and nothing here
// is the source of truth — `src/` still is.

import { hexToSrgb, srgbToHex } from '@/content/colour-hex'
import { readJsonKey, safeLocalStorage, writeJsonKey } from '@/game/storage'

/** One tunable. `get` is read once when the panel is built; `set` runs live. */
export interface LookdevControl {
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
  /** Where the value lives today, so the slider starts where the build is. */
  get(): number
  set(value: number): void
  /**
   * How to write this value back into the source, for the copy button.
   *
   * A format string with `%` where the number goes — e.g.
   * `'unity-fog.ts  FF2_FOG_THINNING = %'`. Without it the copy is a number
   * with no home, which is how a good tuning session produces nothing.
   */
  readonly source: string
  /** Decimal places in the readout and the copy. */
  readonly digits?: number
}

/** A yes/no tunable. Same contract as a slider, minus the range. */
export interface LookdevToggle {
  readonly label: string
  get(): boolean
  set(value: boolean): void
  /** `%` becomes `true` or `false`. */
  readonly source: string
}

/**
 * A colour tunable: the browser's own picker. DEV-446, for the scene tint —
 * a tint is a colour, and three RGB sliders make a person do a picker's job.
 * sRGB 0..1 in and out; the picker's 8 bits are what it can say.
 */
export interface LookdevColor {
  readonly label: string
  get(): readonly [number, number, number]
  set(value: [number, number, number]): void
  /** `%` becomes `[r, g, b]`, four decimals each. */
  readonly source: string
}

export interface LookdevGroup {
  readonly title: string
  readonly controls: readonly LookdevControl[]
  readonly toggles?: readonly LookdevToggle[]
  /** Drawn before the sliders. Not remembered by `storageKey`. DEV-446. */
  readonly colors?: readonly LookdevColor[]
  /**
   * Called after any control in this group changes, if the change needs more
   * than a uniform write — rebuilding the sky, say. Kept per group so a cheap
   * slider never pays for an expensive one.
   */
  rebuild?(): void
  /**
   * A whole JSON block this group edits, for its own **Copy JSON** button.
   * DEV-129. `path` is where the block lands (`content/editions/<id>.json
   * cockpit.placement`) and `value()` is the live block, so the paste is exact
   * rather than a list of source lines to transcribe.
   */
  readonly json?: { readonly path: string; value(): unknown }
  /**
   * Remember this group's numbers in `localStorage` under this key, and put them
   * back on the next build. DEV-129, and the ONE exception to the header's
   * "nothing here persists": Matt asked for a placement he could fine-tune across
   * reloads, and a placement session is many reloads. What keeps the exception
   * honest is that only the panel reads the key — a build without `?lookdev=1`
   * never consults it, so the game cannot quietly behave differently for one
   * person — and the group gets a **Reset** button that clears it.
   */
  readonly storageKey?: string
}

export interface Lookdev {
  readonly element: HTMLElement
  /** Show or hide. Bound to `L` by the caller. */
  toggle(): void
  dispose(): void
}

/** A literal newline, kept out of the string above so no escape can be mangled. */
const NEWLINE = String.fromCharCode(10)

/** sRGB 0..1 → the picker's `#rrggbb`. Clamped, so a value past 1 is white, not garbage. */
export const colorToHex = srgbToHex

/** The picker's `#rrggbb` → sRGB 0..1. */
export const hexToColor = hexToSrgb

/** `[r, g, b]` as a paste-ready literal, four decimals. */
const colorText = (c: readonly number[]): string =>
  `[${c
    .slice(0, 3)
    .map((v) => Number(v.toFixed(4)))
    .join(', ')}]`

/**
 * A group's remembered numbers, or null. Never throws: a private window, a
 * blocked store and a hand-edited key that is not JSON are all "no memory".
 */
const readStore = (key: string | undefined): Record<string, unknown> | null => {
  if (!key) return null
  const parsed = readJsonKey(safeLocalStorage(), key)
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
}

/** Write a group's numbers, or clear them with `null`. Never throws. */
const writeStore = (key: string, value: Record<string, number> | null): void => {
  // Quota, a private window, storage off: the slider still moved the frame, it
  // just will not be remembered. The hint says as much.
  if (value !== null) {
    writeJsonKey(safeLocalStorage(), key, value)
    return
  }
  try {
    safeLocalStorage()?.removeItem(key)
  } catch {
    // Same: an unremembered reset.
  }
}

const CSS = `
.ff2-lookdev {
  position: fixed; top: 12px; right: 12px; width: 300px; max-height: 88vh;
  overflow-y: auto; z-index: 40; box-sizing: border-box;
  background: rgba(14, 18, 26, 0.92); color: #d8e2ee;
  border: 1px solid rgba(140, 200, 255, 0.25); border-radius: 6px;
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding: 10px 12px 12px;
}
.ff2-lookdev[hidden] { display: none !important; }
.ff2-lookdev h2 {
  margin: 0 0 8px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: #7fd1ff; font-weight: 600;
}
.ff2-lookdev h3 {
  margin: 12px 0 4px; font-size: 10px; letter-spacing: 0.06em;
  text-transform: uppercase; color: #8fa4bd; font-weight: 600;
}
.ff2-lookdev label { display: block; margin: 6px 0 0; }
.ff2-lookdev .row { display: flex; justify-content: space-between; gap: 8px; }
.ff2-lookdev .val { color: #ffd98a; }
.ff2-lookdev input[type=range] { width: 100%; margin: 2px 0 0; accent-color: #7fd1ff; }
.ff2-lookdev input[type=color] {
  width: 100%; height: 22px; margin: 2px 0 0; padding: 0; cursor: pointer;
  background: none; border: 1px solid rgba(140, 200, 255, 0.35); border-radius: 3px;
}
.ff2-lookdev button {
  margin-top: 12px; width: 100%; padding: 6px; cursor: pointer;
  background: rgba(127, 209, 255, 0.16); color: #d8e2ee;
  border: 1px solid rgba(140, 200, 255, 0.35); border-radius: 4px;
  font: inherit;
}
.ff2-lookdev button:hover { background: rgba(127, 209, 255, 0.28); }
.ff2-lookdev .hint { margin-top: 8px; color: #7d8ea3; }
.ff2-lookdev label.toggle {
  display: flex; align-items: center; gap: 7px; margin-top: 8px; cursor: pointer;
}
.ff2-lookdev label.toggle input { accent-color: #7fd1ff; margin: 0; }
`

/**
 * Build the panel.
 *
 * Hidden until `toggle()`. Returns `null` nowhere — a caller that does not want
 * it simply does not call this.
 */
export const createLookdev = (groups: readonly LookdevGroup[]): Lookdev => {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.append(style)

  const root = document.createElement('aside')
  root.className = 'ff2-lookdev'
  root.hidden = true
  // `hidden` rather than `style.display`, so nothing else has to know what the
  // panel's display mode was.
  const heading = document.createElement('h2')
  // The pointer-lock line, stated where it bites: while the canvas holds the
  // pointer nothing on this panel is clickable (DEV-070), and that is what
  // pointer lock means, not a bug in the panel.
  heading.textContent = 'lookdev — L to hide · Esc frees the pointer first'
  root.append(heading)

  /**
   * Every control, in panel order, for the copy button.
   *
   * Erased to a source line and a thunk rather than kept as a control plus a
   * value, so a slider and a toggle can sit in the same list and the copy does
   * not have to know which is which.
   */
  const all: { source: string; text(): string }[] = []

  for (const group of groups) {
    const title = document.createElement('h3')
    title.textContent = group.title
    root.append(title)

    // ── the group's colours, if it has any (DEV-446) ─────────────────────
    //
    // The browser's own picker, live on `input`, with the triple beside it so
    // the number that goes into the JSON is on screen and not only in the copy.
    for (const color of group.colors ?? []) {
      const entry = { value: [...color.get()] as [number, number, number] }
      all.push({ source: color.source, text: () => colorText(entry.value) })

      const label = document.createElement('label')
      const row = document.createElement('div')
      row.className = 'row'
      const name = document.createElement('span')
      name.textContent = color.label
      const readout = document.createElement('span')
      readout.className = 'val'
      readout.textContent = colorText(entry.value)
      row.append(name, readout)

      const picker = document.createElement('input')
      picker.type = 'color'
      picker.value = colorToHex(entry.value)
      picker.addEventListener('input', () => {
        entry.value = hexToColor(picker.value)
        readout.textContent = colorText(entry.value)
        color.set([...entry.value])
        group.rebuild?.()
      })
      label.append(row, picker)
      root.append(label)
    }

    // ── the group's memory, if it has one (DEV-129) ──────────────────────
    //
    // Stored per control LABEL, so a control added later comes up at the
    // build's value rather than at a neighbour's number. Every read and write
    // is guarded: storage can be absent, blocked or full, and a panel that
    // throws on build is a panel nobody gets.
    const remembered = readStore(group.storageKey)
    /** The build's own values, captured BEFORE the memory is applied, for Reset. */
    const builtWith = new Map<string, number>()
    const live = new Map<string, { value: number; apply(v: number): void }>()
    const remember = (): void => {
      if (!group.storageKey) return
      const out: Record<string, number> = {}
      for (const [label, entry] of live) out[label] = entry.value
      writeStore(group.storageKey, out)
    }

    for (const control of group.controls) {
      const built = control.get()
      builtWith.set(control.label, built)
      const stored = remembered?.[control.label]
      const entry = {
        value: typeof stored === 'number' && Number.isFinite(stored) ? stored : built,
      }
      const digits = control.digits ?? 3
      all.push({ source: control.source, text: () => entry.value.toFixed(digits) })

      const label = document.createElement('label')
      const row = document.createElement('div')
      row.className = 'row'
      const name = document.createElement('span')
      name.textContent = control.label
      const readout = document.createElement('span')
      readout.className = 'val'
      readout.textContent = entry.value.toFixed(digits)
      row.append(name, readout)

      const slider = document.createElement('input')
      slider.type = 'range'
      slider.min = String(control.min)
      slider.max = String(control.max)
      slider.step = String(control.step)
      slider.value = String(entry.value)
      const apply = (v: number): void => {
        entry.value = v
        slider.value = String(v)
        readout.textContent = v.toFixed(digits)
        control.set(v)
      }
      slider.addEventListener('input', () => {
        apply(Number(slider.value))
        group.rebuild?.()
        remember()
      })
      live.set(control.label, {
        get value() {
          return entry.value
        },
        apply,
      })
      // A remembered number is applied to the LIVE value now, the way a drag
      // would, so the frame shows what the slider says from the first paint.
      if (entry.value !== built) control.set(entry.value)

      label.append(row, slider)
      root.append(label)
    }
    if (group.storageKey && live.size > 0) group.rebuild?.()

    if (group.json) {
      const { path, value } = group.json
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = `Copy JSON → ${path}`
      button.addEventListener('click', () => {
        // The exact block, indented as the preset files are, with the path on
        // the first line so the paste knows where it goes.
        const text = `// ${path}${NEWLINE}${JSON.stringify(value(), null, 2)}`
        void navigator.clipboard?.writeText(text).catch(() => {})
        console.info(`lookdev json:\n${text}`)
        button.textContent = 'Copied — also in the console'
        setTimeout(() => {
          button.textContent = `Copy JSON → ${path}`
        }, 1600)
      })
      root.append(button)
    }
    const storageKey = group.storageKey
    if (storageKey) {
      const reset = document.createElement('button')
      reset.type = 'button'
      reset.textContent = `Reset ${group.title} to the build`
      reset.addEventListener('click', () => {
        for (const [label, entry] of live) {
          const built = builtWith.get(label)
          if (built !== undefined) entry.apply(built)
        }
        group.rebuild?.()
        writeStore(storageKey, null)
      })
      root.append(reset)
    }

    for (const toggle of group.toggles ?? []) {
      const entry = { value: toggle.get() }
      all.push({ source: toggle.source, text: () => String(entry.value) })

      const label = document.createElement('label')
      label.className = 'toggle'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = entry.value
      const name = document.createElement('span')
      name.textContent = toggle.label
      box.addEventListener('change', () => {
        entry.value = box.checked
        toggle.set(box.checked)
        group.rebuild?.()
      })
      label.append(box, name)
      root.append(label)
    }
  }

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = 'Copy settings'
  copy.addEventListener('click', () => {
    const text = all.map((entry) => entry.source.replace('%', entry.text())).join(NEWLINE)
    // `writeText` needs a secure context, which `pnpm dev` is (HTTPS). The
    // console line is the fallback and the receipt: a copy nobody can see
    // happen is a copy nobody trusts.
    void navigator.clipboard?.writeText(text).catch(() => {})
    console.info(`lookdev settings:\n${text}`)
    copy.textContent = 'Copied — also in the console'
    setTimeout(() => {
      copy.textContent = 'Copy settings'
    }, 1600)
  })
  root.append(copy)

  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = groups.some((g) => g.storageKey)
    ? 'Nothing here persists except a group with a Reset button, which remembers its numbers in this browser — and only while ?lookdev=1 is on.'
    : 'Nothing here persists. Reload returns to the build.'
  root.append(hint)

  document.body.append(root)

  return {
    element: root,
    toggle() {
      root.hidden = !root.hidden
    },
    dispose() {
      root.remove()
      style.remove()
    },
  }
}
