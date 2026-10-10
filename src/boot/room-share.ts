// src/boot/room-share.ts: getting a room's code from one person to another
// without typing it on the letter plate. DEV-632.
//
// Matt, 2026-10-04, after a session with phone and PC players: *"so typing a
// room code on mobile is painful, same with PC."* The plate (DEV-441b,
// `game/room-code.ts`) is right in a headset, where nothing else can type; on
// a flat screen the device already has a better keyboard than ours. Three
// pieces of DOM, each only on the screens that have the thing it uses:
//
//   - the CODE FIELD, a phone's: a real `<input>` over the top of the screen
//     while the letter plate is up, so a tap raises the system keyboard (and
//     its paste). Capitals, no autocorrect, no autocomplete, no spellcheck, and
//     16 px or larger so iOS does not zoom the page on focus. What it holds is
//     `codeCharsOf` of what was typed, and the plate mirrors it; a key tapped
//     on the plate shows here too. The phone is landscape only (DEV-566), and a
//     landscape keyboard covers the bottom half, so the field sits at the TOP,
//     and follows `visualViewport` so iOS's scroll on focus cannot carry it off.
//   - the QR CODE, a computer's: the room's link, drawn by `game/qr-encode.ts`
//     beside the lobby, so a friend's phone camera opens it.
//   - `sendRoomLink`: a phone's system share sheet, falling back to the clipboard.
//
// A computer's keyboard needs no DOM: it types on the plate already, and its
// paste is read in `boot/app.ts` beside the plate's other keys. The headset
// sees none of this (DOM is not drawn in a session), and keeps the plate.

import { encodeQr } from '@/game/qr-encode'
import { codeCharsOf } from '@/game/room-code'
import {
  UI_ACCENT,
  UI_DIM,
  UI_INK,
  UI_ON_ACCENT,
  UI_PLATE,
  UI_PLATE_EDGE,
  UI_STACK,
} from '@/render/ui-tokens'

/** What the frame says should stand this frame. */
export interface RoomShareFrame {
  /** The phone's code field: what the plate has typed, or null for no field. */
  readonly field: { readonly typed: string; readonly busy: boolean } | null
  /** The QR code: the link it carries and the code to print under it, or null. */
  readonly qr: { readonly link: string; readonly code: string } | null
  /** DEV-634: a phone's big START, once everyone is ready (absent is no). */
  readonly start?: boolean
}

export interface RoomShare {
  frame(state: RoomShareFrame): void
}

export interface RoomShareDeps {
  /** The field changed: the plate takes these characters (already `codeCharsOf`). */
  readonly onTyped: (typed: string) => void
  /** The phone keyboard's Go (or Enter): join, if the code is whole. */
  readonly onSubmit: () => void
  /** DEV-634: the big START was tapped: the lobby's START row, pressed. */
  readonly onStart?: () => void
}

/** Pixels the QR's modules are drawn at, and the quiet zone the standard asks for, in modules. */
const QR_MODULE_PX = 5
const QR_QUIET = 4

const FONT = UI_STACK

export const createRoomShare = (deps: RoomShareDeps, doc: Document = document): RoomShare => {
  // ── The code field ──────────────────────────────────────────────────────
  const form = doc.createElement('form')
  form.id = 'room-code-field'
  form.hidden = true
  form.style.cssText =
    'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:30;margin:0;' +
    'display:none;flex-direction:column;align-items:center;gap:4px;pointer-events:auto'
  const input = doc.createElement('input')
  input.id = 'room-code-input'
  input.type = 'text'
  input.name = 'room-code'
  input.setAttribute('inputmode', 'text')
  input.setAttribute('autocapitalize', 'characters')
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('autocorrect', 'off')
  input.setAttribute('spellcheck', 'false')
  input.setAttribute('enterkeyhint', 'go')
  input.setAttribute('aria-label', 'Room code')
  input.placeholder = 'TAP TO TYPE'
  input.style.cssText =
    `width:14ch;padding:8px 12px;border-radius:0;border:1px solid ${UI_PLATE_EDGE};` +
    `border-bottom:3px solid ${UI_ACCENT};background:${UI_PLATE};color:${UI_INK};` +
    `text-align:center;outline:none;font:700 24px/1.2 ${FONT};letter-spacing:.18em;text-transform:uppercase`
  const hint = doc.createElement('div')
  hint.textContent = 'or paste a link'
  hint.style.cssText = `font:500 14px/1.2 ${FONT};color:${UI_DIM};text-shadow:0 1px 2px ${UI_PLATE}`
  form.append(input, hint)
  // The game's touch surface and its keys never hear the field: a tap on it is
  // the field's, and a letter typed into it is not a flight key or a plate key
  // (the plate's capture listener steps aside for it, `boot/app.ts`).
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) {
    form.addEventListener(type, (e) => e.stopPropagation())
  }
  input.addEventListener('keydown', (e) => e.stopPropagation())
  input.addEventListener('input', () => {
    const clean = codeCharsOf(input.value)
    if (input.value !== clean) input.value = clean
    deps.onTyped(clean)
  })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    deps.onSubmit()
  })
  // iOS scrolls the layout on focus and leaves it there: put it back, and
  // keep the field inside what can be seen while the keyboard is up.
  const vv = (globalThis as { visualViewport?: VisualViewport }).visualViewport
  const follow = () => {
    form.style.top = `${10 + (vv?.offsetTop ?? 0)}px`
  }
  vv?.addEventListener('resize', follow)
  vv?.addEventListener('scroll', follow)
  input.addEventListener('blur', () => {
    globalThis.scrollTo?.(0, 0)
    follow()
  })
  doc.body.append(form)

  // ── The QR code ─────────────────────────────────────────────────────────
  const qrBox = doc.createElement('div')
  qrBox.id = 'room-qr'
  qrBox.hidden = true
  qrBox.style.cssText =
    'position:fixed;left:16px;bottom:16px;z-index:6;padding:10px 10px 8px;border-radius:0;' +
    `background:${UI_PLATE};border-left:6px solid ${UI_ACCENT};color:${UI_INK};text-align:center;pointer-events:none;` +
    `font:500 14px/1.3 ${FONT};letter-spacing:.04em`
  const qrCanvas = doc.createElement('canvas')
  qrCanvas.style.cssText = 'display:block;image-rendering:pixelated'
  const qrCaption = doc.createElement('div')
  qrCaption.style.marginTop = '6px'
  qrBox.append(qrCanvas, qrCaption)
  doc.body.append(qrBox)
  let qrDrawn = ''

  // ── DEV-634: a phone's START, once everyone is ready ───────────────────
  //
  // The lobby's rows are a finger's target on a phone, and a small one at a
  // landscape phone's size; the one press everything waits on gets a button a
  // thumb cannot miss, bottom centre, in the room's accent.
  const startButton = doc.createElement('button')
  startButton.id = 'room-start'
  startButton.type = 'button'
  startButton.textContent = 'START'
  startButton.style.cssText =
    'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:30;display:none;' +
    `min-width:200px;min-height:64px;padding:12px 36px;border-radius:0;border:0;` +
    `background:${UI_ACCENT};color:${UI_ON_ACCENT};letter-spacing:.12em;cursor:pointer;` +
    `font:700 26px/1 ${FONT}`
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend']) {
    startButton.addEventListener(type, (e) => e.stopPropagation())
  }
  startButton.addEventListener('click', (e) => {
    e.stopPropagation()
    deps.onStart?.()
  })
  doc.body.append(startButton)

  const drawQr = (link: string, code: string): void => {
    const qr = encodeQr(link)
    if (!qr) {
      qrBox.hidden = true
      qrBox.dataset.link = ''
      return
    }
    const cells = qr.size + QR_QUIET * 2
    qrCanvas.width = cells * QR_MODULE_PX
    qrCanvas.height = cells * QR_MODULE_PX
    const ctx = qrCanvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, qrCanvas.width, qrCanvas.height)
      ctx.fillStyle = '#000000'
      for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
          if (qr.dark[y]?.[x]) {
            ctx.fillRect(
              (x + QR_QUIET) * QR_MODULE_PX,
              (y + QR_QUIET) * QR_MODULE_PX,
              QR_MODULE_PX,
              QR_MODULE_PX,
            )
          }
        }
      }
    }
    qrCaption.textContent = `SCAN TO JOIN ${code}`
    qrBox.dataset.link = link
    qrBox.dataset.version = String(qr.version)
  }

  return {
    frame(state) {
      // The field.
      const showField = state.field !== null
      if (form.hidden === showField) {
        form.hidden = !showField
        form.style.display = showField ? 'flex' : 'none'
        if (!showField && doc.activeElement === input) input.blur()
      }
      if (state.field !== null) {
        if (input.value !== state.field.typed) input.value = state.field.typed
        input.disabled = state.field.busy
      }
      // The QR code.
      const key = state.qr === null ? '' : `${state.qr.link} ${state.qr.code}`
      if (key !== qrDrawn) {
        qrDrawn = key
        if (state.qr !== null) drawQr(state.qr.link, state.qr.code)
      }
      const showQr = state.qr !== null && qrBox.dataset.link !== ''
      if (qrBox.hidden === showQr) qrBox.hidden = !showQr
      // DEV-634: the phone's START.
      const showStart = state.start === true
      const startShown = startButton.style.display !== 'none'
      if (startShown !== showStart) startButton.style.display = showStart ? 'block' : 'none'
    },
  }
}

/**
 * A room's link, sent the way this device sends things: the share sheet where
 * there is one (a phone: a text to a friend is one tap), else the clipboard.
 * `done` hears which, or 'failed'. A share the player cancelled is not a
 * failure and copies nothing: they chose not to.
 */
export const sendRoomLink = (
  link: string,
  share: boolean,
  done: (how: 'shared' | 'copied' | 'cancelled' | 'failed') => void,
): void => {
  const nav = globalThis.navigator as Navigator | undefined
  const copy = () => {
    const writing = nav?.clipboard?.writeText(link)
    if (!writing) {
      done('failed')
      return
    }
    writing.then(
      () => done('copied'),
      () => done('failed'),
    )
  }
  if (share && typeof nav?.share === 'function') {
    nav.share({ title: 'Faceted Flight', text: 'Race me in Faceted Flight', url: link }).then(
      () => done('shared'),
      (err: unknown) => {
        if ((err as { name?: string })?.name === 'AbortError') done('cancelled')
        else copy()
      },
    )
    return
  }
  copy()
}
