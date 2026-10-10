// src/render/race-strip.ts: the flat screen's race strip. DEV-649.
//
// Matt, 2026-10-05: *"i'd love the overall UI aesthetic to be clean-broadcast.
// as if it was for a popular action sports broadcast."* and, to the consultant's
// review, *"go with your recs for everything else"*: a race strip in the top
// corners on a monitor, ON by default, with an Options row to hide it.
//
// ── Why this one is DOM, when the HUD argues the opposite ─────────────────
//
// `hud.ts` says a DOM overlay is invisible in a headset, and that is why the
// instrument panel is geometry in the cockpit. It is also exactly why a strip
// on the glass is the right thing FOR A MONITOR: it exists only while an XR
// session is NOT presenting, where the dash is still the HUD, unchanged. The
// phone's touch controls make the same argument (`input/touch-overlay.ts`).
// A DOM strip is crisp at any pixel ratio, costs no canvas upload, and cannot
// reach the frame the renderer draws, so no pixel-pinned spec of the WebGL
// canvas can see it.
//
// ── What is on it ─────────────────────────────────────────────────────────
//
// TOP LEFT, the thing a race is about: your POSITION, the largest type on the
// screen (`#2` over `/6`), then the GATES count under it, then a SPLIT when one
// is up (`CUTTER +1.4`, in the gain or loss ink). TOP RIGHT, TIME and SCORE; the
// score rolls up to a new value over 0.3 s rather than jumping (`createScoreRoll`).
//
// ── The look ──────────────────────────────────────────────────────────────
//
// Flat solid plates with one hard accent edge, no radius, no gradient, no glass:
// the tokens (`render/ui-tokens.ts`) and the broadcast face, caps for labels and
// tabular figures for every number, so a ticking clock does not jitter.
//
// Pure helpers are exported for the unit tests; the DOM half is `createRaceStrip`.

import { DIGIT_CELL_CSS, setCellText } from '@/render/ui-digits'
import { AI_TAG } from '@/render/ui-draw'
import {
  UI_ACCENT,
  UI_ALERT,
  UI_DIM,
  UI_GAIN,
  UI_INK,
  UI_LOSS,
  UI_PLATE,
  UI_PLATE_EDGE,
  UI_STACK,
} from '@/render/ui-tokens'

/** The score takes this long to roll to a new value. The brief: "about 0.3 s". */
export const SCORE_ROLL_SECONDS = 0.3

/** The id of the strip's root, for the specs and for `app.ts`'s one-line mount. */
export const RACE_STRIP_ID = 'race-strip'
/** The one-time hint's id. */
export const CAMERA_HINT_ID = 'camera-hint'

/** How long a position change keeps the number flashing, seconds. */
export const POSITION_FLASH_SECONDS = 0.8
/** How long the camera hint stays up the one time it shows, seconds. */
export const CAMERA_HINT_SECONDS = 7

/**
 * A number that eases to its target: `set` it when the reading changes, ask for
 * `value` each frame. Ease-out, so the first part of a gate's points lands at
 * once and the last digits settle. A new target mid-roll starts from where the
 * number IS, never from the old target, so two gates in a row do not jump back.
 * A target BELOW the last one snaps: a score only rises inside a run.
 */
export interface ScoreRoll {
  /** The target. A change starts a roll from the value being shown. */
  set(target: number, nowMs: number): void
  /** The value to show at `nowMs`: a whole number. */
  value(nowMs: number): number
  /** Is it still moving at `nowMs`? */
  rolling(nowMs: number): boolean
  /** Snap: a new run starts from its own number, not a roll down from the last one. */
  snap(target: number): void
}

export const createScoreRoll = (seconds: number = SCORE_ROLL_SECONDS): ScoreRoll => {
  let from = 0
  let to = 0
  let startMs = 0
  let primed = false
  const at = (nowMs: number): number => {
    const t = Math.min(1, Math.max(0, (nowMs - startMs) / (seconds * 1000)))
    const eased = 1 - (1 - t) * (1 - t)
    return from + (to - from) * eased
  }
  return {
    set(target, nowMs) {
      if (!primed) {
        // The first reading is the starting point, not something to roll to.
        from = to = target
        primed = true
        return
      }
      if (target === to) return
      // A score only goes up inside a run. Going down is a new run: it starts
      // from its own number rather than rolling down from the last one's.
      if (target < to) {
        from = to = target
        return
      }
      from = at(nowMs)
      to = target
      startMs = nowMs
    },
    value: (nowMs) => Math.round(at(nowMs)),
    rolling: (nowMs) => from !== to && nowMs - startMs < seconds * 1000,
    snap(target) {
      from = to = target
      primed = true
    },
  }
}

/** What the strip is told each frame. All of it is already formatted: this draws, it does not decide. */
export interface RaceStripState {
  /** Draw the strip at all: flat, flying, not paused, not over, and the player has it on. */
  readonly visible: boolean
  /** The player's place, or null where nobody races (the block is then absent). */
  readonly place: number | null
  /** How many are racing, the player included. */
  readonly field: number
  readonly countLabel: string
  /** `07/21`. */
  readonly count: string
  readonly timeLabel: string
  /** The clock's own text (`formatTime`): `--` where there is none. */
  readonly time: string
  /** The last twenty seconds of a countdown: the clock takes the alert ink. */
  readonly urgent: boolean
  /** The score as it stands, in points. The strip rolls it. */
  readonly score: number
  /** The split to show, or null. One entry per line. */
  readonly split:
    | readonly {
        readonly who: string
        readonly gap: string
        readonly tone: 'gain' | 'loss'
        /** DEV-854: an AI rival, tagged on its line. */
        readonly ai?: boolean
      }[]
    | null
  /** Touch controls are on the glass: sit under their top row. */
  readonly touch: boolean
}

export interface RaceStrip {
  readonly element: HTMLElement | null
  update(state: RaceStripState, nowMs: number): void
  /** The one-time camera hint: show it now (the caller decided it is the first flat flight). */
  showCameraHint(nowMs: number): void
  readonly hintShowing: boolean
  dispose(): void
}

const STYLE_ID = 'race-strip-style'

/**
 * The stylesheet. A template literal, so no backticks anywhere inside it (the
 * touch overlay's header says what one costs). Every colour is a token.
 */
const CSS = `
#${RACE_STRIP_ID} {
  position: fixed;
  z-index: 1;
  inset: 0;
  pointer-events: none;
  font-family: ${UI_STACK};
  font-synthesis: none;
  text-transform: uppercase;
  color: ${UI_INK};
}
#${RACE_STRIP_ID}[hidden] { display: none; }
#${RACE_STRIP_ID} .side {
  position: absolute;
  top: calc(16px + env(safe-area-inset-top, 0px));
  display: flex;
  flex-direction: column;
  gap: 6px;
}
#${RACE_STRIP_ID}[data-touch="1"] .side { top: calc(70px + env(safe-area-inset-top, 0px)); }
#${RACE_STRIP_ID} .left { left: calc(18px + env(safe-area-inset-left, 0px)); align-items: flex-start; }
#${RACE_STRIP_ID} .right { right: calc(18px + env(safe-area-inset-right, 0px)); align-items: flex-end; }
#${RACE_STRIP_ID} .plate {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 4px 14px 5px 12px;
  background: ${UI_PLATE};
  border: 1px solid ${UI_PLATE_EDGE};
  border-left: 5px solid ${UI_ACCENT};
}
#${RACE_STRIP_ID} .right .plate { border-left: 1px solid ${UI_PLATE_EDGE}; border-right: 5px solid ${UI_ACCENT}; padding: 4px 12px 5px 14px; }
#${RACE_STRIP_ID} .k { font-size: 13px; font-weight: 700; letter-spacing: 0.14em; color: ${UI_DIM}; }
#${RACE_STRIP_ID} .v { font-size: 26px; font-weight: 700; line-height: 1.05; }
#${RACE_STRIP_ID} .pos { padding: 2px 18px 3px 14px; gap: 6px; }
#${RACE_STRIP_ID} .pos .k { color: ${UI_ACCENT}; }
#${RACE_STRIP_ID} .pos .n { font-size: 76px; font-weight: 700; line-height: 0.95; color: ${UI_ACCENT}; }
#${RACE_STRIP_ID} .pos .p { font-size: 30px; font-weight: 700; color: ${UI_INK}; }
#${RACE_STRIP_ID} .pos .of { font-size: 26px; font-weight: 700; color: ${UI_DIM}; }
#${RACE_STRIP_ID} .pos[data-flash="gain"] .n { color: ${UI_GAIN}; }
#${RACE_STRIP_ID} .pos[data-flash="loss"] .n { color: ${UI_LOSS}; }
#${RACE_STRIP_ID} .v[data-urgent="1"] { color: ${UI_ALERT}; }
#${RACE_STRIP_ID} .split { display: flex; flex-direction: column; gap: 3px; }
#${RACE_STRIP_ID} .split .line {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 3px 14px 4px 12px;
  background: ${UI_PLATE};
  border-left: 5px solid ${UI_GAIN};
}
#${RACE_STRIP_ID} .split .line[data-tone="loss"] { border-left-color: ${UI_LOSS}; }
#${RACE_STRIP_ID} .split .who { font-size: 16px; font-weight: 700; letter-spacing: 0.1em; color: ${UI_INK}; }
#${RACE_STRIP_ID} .split .ai { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: ${UI_DIM}; border: 1px solid ${UI_DIM}; padding: 0 4px; align-self: center; }
#${RACE_STRIP_ID} .split .gap { font-size: 28px; font-weight: 700; color: ${UI_GAIN}; }
#${RACE_STRIP_ID} .split .line[data-tone="loss"] .gap { color: ${UI_LOSS}; }
#${RACE_STRIP_ID} .split[hidden], #${RACE_STRIP_ID} .plate[hidden] { display: none; }
@media (prefers-reduced-motion: no-preference) {
  #${RACE_STRIP_ID} .split .line { animation: ${RACE_STRIP_ID}-in 140ms ease-out both; }
  @keyframes ${RACE_STRIP_ID}-in { from { transform: translateX(-24px); opacity: 0; } to { transform: none; opacity: 1; } }
}
@media (max-height: 520px) {
  #${RACE_STRIP_ID} .pos .n { font-size: 52px; }
  #${RACE_STRIP_ID} .pos .p, #${RACE_STRIP_ID} .pos .of { font-size: 20px; }
  #${RACE_STRIP_ID} .v { font-size: 20px; }
  #${RACE_STRIP_ID} .k { font-size: 11px; }
  #${RACE_STRIP_ID} .split .gap { font-size: 22px; }
  #${RACE_STRIP_ID}[data-touch="1"] .side { top: calc(60px + env(safe-area-inset-top, 0px)); }
}
#${CAMERA_HINT_ID} {
  position: fixed;
  z-index: 1;
  left: 50%;
  top: calc(18px + env(safe-area-inset-top, 0px));
  transform: translateX(-50%);
  pointer-events: none;
  font-family: ${UI_STACK};
  font-synthesis: none;
  text-transform: uppercase;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.12em;
  padding: 6px 18px 7px;
  color: ${UI_INK};
  background: ${UI_PLATE};
  border: 1px solid ${UI_PLATE_EDGE};
  border-bottom: 4px solid ${UI_ACCENT};
}
#${CAMERA_HINT_ID}[hidden] { display: none; }
#${CAMERA_HINT_ID} b { color: ${UI_ACCENT}; font-weight: 700; }
/* CRYSTAL has no tabular figures: a ticking digit sits in a cell (DEV-848) */
${DIGIT_CELL_CSS}
`

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls: string,
  text = '',
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag)
  if (cls) node.className = cls
  if (text) node.textContent = text
  return node
}

/** `1,200`-free: digits only, so the figures stay the width the tabular face gives them. */
export const scoreText = (points: number): string => String(Math.max(0, Math.round(points)))

/**
 * Mount the strip. A host with no DOM (a unit test in node) gets an inert one:
 * the same interface, drawing nothing, so the caller needs no branch.
 */
export const createRaceStrip = (doc: Document | null): RaceStrip => {
  if (!doc?.body) {
    return {
      element: null,
      update: () => {},
      showCameraHint: () => {},
      hintShowing: false,
      dispose: () => {},
    }
  }
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    doc.head.appendChild(style)
  }

  const root = el(doc, 'div', '')
  root.id = RACE_STRIP_ID
  root.hidden = true
  root.setAttribute('aria-hidden', 'true')

  // ── top left: position, gates, split ──────────────────────────────────
  const left = el(doc, 'div', 'side left')
  const pos = el(doc, 'div', 'plate pos')
  // DEV-855: the readout is yours, and says so.
  const posYou = el(doc, 'span', 'k', 'YOU')
  const posP = el(doc, 'span', 'p', '#')
  const posN = el(doc, 'span', 'n')
  const posOf = el(doc, 'span', 'of')
  pos.append(posYou, posP, posN, posOf)
  const gates = el(doc, 'div', 'plate gates')
  const gatesK = el(doc, 'span', 'k')
  const gatesV = el(doc, 'span', 'v')
  gates.append(gatesK, gatesV)
  const split = el(doc, 'div', 'split')
  left.append(pos, gates, split)

  // ── top right: time, score ────────────────────────────────────────────
  const right = el(doc, 'div', 'side right')
  const time = el(doc, 'div', 'plate time')
  const timeK = el(doc, 'span', 'k')
  const timeV = el(doc, 'span', 'v')
  time.append(timeK, timeV)
  const score = el(doc, 'div', 'plate score')
  const scoreK = el(doc, 'span', 'k', 'SCORE')
  const scoreV = el(doc, 'span', 'v')
  score.append(scoreK, scoreV)
  right.append(time, score)

  root.append(left, right)
  doc.body.appendChild(root)

  const hint = el(doc, 'div', '')
  hint.id = CAMERA_HINT_ID
  hint.hidden = true
  const hintKey = el(doc, 'b', '', 'V')
  hint.append(hintKey, doc.createTextNode(': camera'))
  doc.body.appendChild(hint)
  let hintUntil = 0

  const roll = createScoreRoll()
  let lastPlace: number | null = null
  let flashUntil = 0
  let flashTone: 'gain' | 'loss' | '' = ''
  let lastSplit = ''
  let lastText = ''

  return {
    element: root,
    update(state, nowMs) {
      if (hint.hidden === false && nowMs >= hintUntil) hint.hidden = true
      if (root.hidden === state.visible) root.hidden = !state.visible
      // The score keeps rolling while hidden, so it is right the frame it returns.
      roll.set(state.score, nowMs)
      if (!state.visible) return
      if (root.dataset.touch !== (state.touch ? '1' : '0'))
        root.dataset.touch = state.touch ? '1' : '0'

      // The position, and its flash on a change (DEV-641 reads the same change).
      const hasPlace = state.place !== null && state.field > 1
      pos.hidden = !hasPlace
      if (hasPlace && state.place !== null) {
        if (lastPlace !== null && state.place !== lastPlace) {
          flashTone = state.place < lastPlace ? 'gain' : 'loss'
          flashUntil = nowMs + POSITION_FLASH_SECONDS * 1000
        }
        lastPlace = state.place
        setCellText(posN, String(state.place))
        posOf.textContent = `/${state.field}`
      } else {
        lastPlace = null
      }
      const flash = nowMs < flashUntil ? flashTone : ''
      if (pos.dataset.flash !== flash) {
        if (flash) pos.dataset.flash = flash
        else delete pos.dataset.flash
      }

      // Text is written only when it changed: a DOM write is cheap, a layout is not.
      const text = [
        state.countLabel,
        state.count,
        state.timeLabel,
        state.time,
        state.urgent,
        scoreText(roll.value(nowMs)),
      ].join('|')
      if (text !== lastText) {
        lastText = text
        gatesK.textContent = state.countLabel
        setCellText(gatesV, state.count)
        timeK.textContent = state.timeLabel
        setCellText(timeV, state.time)
        timeV.dataset.urgent = state.urgent ? '1' : '0'
        setCellText(scoreV, scoreText(roll.value(nowMs)))
      }

      // The split: rebuilt only when its words change, so the slide-in plays once.
      const splitKey = state.split
        ? state.split.map((s) => `${s.who}${s.gap}${s.tone}${s.ai ? 'ai' : ''}`).join('/')
        : ''
      if (splitKey !== lastSplit) {
        lastSplit = splitKey
        split.replaceChildren()
        for (const entry of state.split ?? []) {
          const line = el(doc, 'div', 'line')
          line.dataset.tone = entry.tone
          line.append(el(doc, 'span', 'who', entry.who))
          if (entry.ai) line.append(el(doc, 'span', 'ai', AI_TAG))
          line.append(el(doc, 'span', 'gap', entry.gap))
          split.appendChild(line)
        }
        split.hidden = !state.split
      }
    },
    showCameraHint(nowMs) {
      hint.hidden = false
      hintUntil = nowMs + CAMERA_HINT_SECONDS * 1000
    },
    get hintShowing() {
      return !hint.hidden
    },
    dispose() {
      root.remove()
      hint.remove()
    },
  }
}
