// src/boot/app/hangar/letter-plate.ts: Multiplayer's JOIN WITH A CODE, out of
// `bootApp`. APP-SPLIT phase 4, slice 6 (hangar and menus; `docs/plan/APP-SPLIT.md` §5).
//
// DEV-441b's letter plate (the hangar's since DEV-558) and DEV-632's code that
// arrives whole (a paste, a typed word, the phone's keyboard). Every line below
// was moved verbatim from the closure; the plumbing is `ctx.x` where the code
// reads a binding the closure still owns (a getter, so a check narrows as the
// closure's `let` did, and a setter where this code writes one: the §6 rule 3
// bag), and the returned object, which hands the closure what it still calls.

import { createRoomShare } from '@/boot/room-share'
import type { RoomClient } from '@/game/room-client'
import {
  CODE_ACTION,
  CODE_KEYS,
  codeFromPaste,
  codeKeyForKeyboard,
  codeKeyIndex,
  codeTypedText,
  pressCodeKey,
} from '@/game/room-code'
import { LOBBY_ACTION, roomCodeText } from '@/game/room-lobby'
import { createEdge } from '@/input/edge'
import { isTextEntry } from '@/input/text-entry'
import { ROOM_CODE_LENGTH } from '@/net/room-protocol'
import type { ControlsDevice } from '@/render/controls-menu'
import { chooseWords } from '@/render/controls-menu'
import type { HangarArt } from '@/render/hangar'
import type { PauseOption } from '@/render/pause'
import type { CodePlate } from '@/render/room-code-plate'

/** What `createLetterPlate` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface LetterPlateCtx {
  readonly confirmDevice: () => ControlsDevice
  readonly hangar: HangarArt | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  lobbyAim: number
  readonly lobbyPress: () => void
  readonly lobbyRows: readonly PauseOption[]
  readonly lobbyUp: () => boolean
  readonly room: RoomClient | null
  readonly roomClose: () => void
  readonly roomOpen: (id: string, opts?: { readonly existing?: boolean }) => void
  readonly screen: 'title' | 'menu' | 'mission'
}

export const createLetterPlate = (ctx: LetterPlateCtx) => {
  // ── DEV-441b: the letter plate — Multiplayer's JOIN WITH A CODE ──────
  //
  // In the HANGAR since DEV-558 (`render/room-code-plate.ts`, `game/room-code.ts`):
  // a press of the Multiplayer step's JOIN WITH A CODE table opens it in front
  // of the chair, and the room's tables are put by while it is up (`focus`,
  // DEV-465's hide). The head, a laser, a finger or the cursor picks a key while
  // it is ON one; the stick and the arrow keys step it in two axes; the confirm
  // every device rides presses it; a keyboard types. JOIN asks for a seat with
  // `existing`, so a typo is refused (4004) rather than seated alone in a new
  // room, and WAITS here: a seat closes the plate and the lobby stands, a
  // refusal is said on the plate with the code left to correct. BACK, B, or
  // Backspace on nothing closes it, back to the Multiplayer step.
  let codePlate: CodePlate | null = null
  let codeOpen = false
  let codeTyped = ''
  let codeAim = 0
  /**
   * The key the gaze was on last frame, or -1 (DEV-558). The plate stands in
   * the hangar now, where the resting look points DOWN at the tables, so the
   * eye can rest on a key; the gaze takes the aim when it MOVES to a key, and
   * a still gaze no longer undoes every arrow press.
   */
  let codeLooked = -1
  /** The code a join is in flight for, or null. */
  let codeJoining: string | null = null
  /** Why the last join did not seat this page, or null. */
  let codeRefusal: string | null = null
  /** One step per push of the letter plate's stick, across and down. */
  const codeNudgeEdge = createEdge()
  /** Keys a keyboard sent since the last frame (`KeyboardEvent.key`): spent by the frame, in order. */
  const codeKeysDown: string[] = []
  /** The sentinel the room's tables are focused on while the plate is up: no table stands for it. */
  const CODE_LENT = 'room-code:plate'
  /** Is the letter plate up? In the hangar, in front of the chair (DEV-558). */
  const codeUp = (): boolean => codeOpen && ctx.screen === 'menu' && ctx.hangar !== null
  const codeOpenPlate = (): void => {
    codeOpen = true
    codeTyped = ''
    codeRefusal = null
    codeAim = 0
    codeKeysDown.length = 0
    ctx.hangar?.focus(CODE_LENT)
    console.info('hangar: the letter plate')
  }
  const codeClosePlate = (): void => {
    codeOpen = false
    codeJoining = null
    if (ctx.hangar?.focused === CODE_LENT) ctx.hangar.focus(null)
    console.info('hangar: back from the letter plate')
  }
  /** JOIN: the room the code names, IF somebody is in it. The frame watches the answer. */
  const codeJoin = (code: string): void => {
    if (ctx.room) ctx.roomClose()
    codeJoining = code
    codeRefusal = null
    ctx.roomOpen(code, { existing: true })
    console.info(`hangar: joining ${code}`)
  }
  /** Press key `index` (any device), and do what it says. */
  const codePress = (index: number): void => {
    const key = CODE_KEYS[index]
    if (!key || codeJoining !== null) return
    const was = codeTyped
    const { typed, outcome } = pressCodeKey(codeTyped, key)
    codeTyped = typed
    if (typed !== was) codeRefusal = null
    if (outcome === 'back') codeClosePlate()
    else if (outcome === 'join') codeJoin(typed)
    // A whole code puts the aim on JOIN, so the next confirm — Enter, A, a
    // trigger — is the join, whichever way the code was typed.
    else if (outcome === 'typed' && typed.length === ROOM_CODE_LENGTH) {
      codeAim = codeKeyIndex(CODE_ACTION.join)
    }
  }
  /** Every hangar frame: a join in flight is seated (the lobby) or refused (said here). */
  const codeJoinFrame = (): void => {
    if (codeJoining === null || !ctx.room) return
    if (ctx.room.session.slot !== null) {
      const code = codeJoining
      codeJoining = null
      // Seated: the plate goes and the lobby stands, where the room's are.
      codeClosePlate()
      console.info(`hangar: into the room ${code}`)
    } else if (ctx.room.status === 'closed') {
      codeRefusal = ctx.room.notice ?? 'The room could not be reached.'
      console.info(`hangar: ${codeJoining} refused: ${codeRefusal}`)
      codeJoining = null
      ctx.roomClose()
    }
  }
  /** The plate's live state, for its painter and the probe. The footer's verb follows the device. */
  const codePlateState = (device = ctx.confirmDevice()) => {
    const whole = codeTyped.length === ROOM_CODE_LENGTH
    return {
      heading: 'JOIN WITH A CODE',
      typed: codeTypedText(codeTyped),
      selected: codeAim,
      live: CODE_KEYS.map((k) =>
        k.char !== null ? !whole : k.id === CODE_ACTION.join ? whole : true,
      ),
      footer:
        codeJoining !== null
          ? `looking for room ${roomCodeText(codeJoining)}…`
          : (codeRefusal ??
            (whole
              ? `${chooseWords(device)}: join`
              : device === 'keyboard'
                ? 'type the code a friend reads you'
                : `${chooseWords(device)} · the code a friend reads you`)),
      footerAccent: codeRefusal !== null || (whole && codeJoining === null),
    }
  }
  // A keyboard TYPES on the plate: its letters are the code's, not the flight
  // keys' or the autopilot's P (which would otherwise arm the next flight), so
  // they are taken here, before `input/keyboard.ts` hears them — capture phase,
  // on the window it listens on. Only while the plate is up, and only the keys
  // the plate uses: Enter still confirms. The arrow keys step the plate, and
  // in the hangar they would also turn the seat, so they are the plate's too.
  //
  // DEV-632: a key with Ctrl, Cmd or Alt is not a letter (Ctrl+V is the paste
  // below, and V is in the alphabet), and a key typed into the phone's code
  // field is the field's (`boot/room-share.ts`).
  globalThis.addEventListener(
    'keydown',
    (e) => {
      if (!codeUp()) return
      const ke = e as KeyboardEvent
      if (ke.ctrlKey || ke.metaKey || ke.altKey || isTextEntry(ke.target)) return
      const k = ke.key
      if (codeKeyForKeyboard(k) !== null || k.startsWith('Arrow')) {
        e.stopPropagation()
        e.preventDefault()
        // A held key types once, as a press of a key on the plate does.
        if (!(e as KeyboardEvent).repeat) codeKeysDown.push(k)
      }
    },
    { capture: true },
  )
  // ── DEV-632: a code that arrives whole ──────────────────────────────────
  //
  // Matt, 2026-10-04: *"typing a room code on mobile is painful, same with
  // PC."* A computer's Ctrl+V or Cmd+V pastes a code, or a whole invite link
  // (`codeFromPaste` takes its room), onto the plate; a phone's code field
  // (`boot/room-share.ts`) hands the plate what its system keyboard typed. A
  // whole code puts the aim on JOIN either way, so the next confirm joins.
  /** The plate's text, set whole (a paste, the phone's field). */
  const codeSet = (text: string): void => {
    if (!codeUp() || codeJoining !== null) return
    if (text !== codeTyped) codeRefusal = null
    codeTyped = text
    if (text.length === ROOM_CODE_LENGTH) codeAim = codeKeyIndex(CODE_ACTION.join)
  }
  globalThis.addEventListener('paste', (e) => {
    if (!codeUp() || (e as ClipboardEvent).target instanceof HTMLInputElement) return
    e.preventDefault()
    const code = codeFromPaste((e as ClipboardEvent).clipboardData?.getData('text') ?? '')
    if (code === null) {
      codeRefusal = 'That is not a room code.'
      console.info('hangar: a paste with no room code in it')
    } else {
      codeSet(code)
      console.info(`hangar: pasted ${code}`)
    }
  })
  const roomShare = createRoomShare({
    // DEV-634: the phone's big START: the lobby's own START row, pressed.
    onStart: () => {
      const at = ctx.lobbyRows.findIndex((r) => r.id === LOBBY_ACTION.start)
      if (!ctx.lobbyUp() || at < 0) return
      ctx.lobbyAim = at
      ctx.lobbyPress()
    },
    onTyped: codeSet,
    onSubmit: () => {
      if (codeUp() && codeTyped.length === ROOM_CODE_LENGTH && codeJoining === null) {
        codeJoin(codeTyped)
      }
    },
  })
  return {
    codeOpenPlate,
    codeUp,
    codeNudgeEdge,
    codeKeysDown,
    codePress,
    codeClosePlate,
    codeJoinFrame,
    codePlateState,
    roomShare,
    get codeOpen() {
      return codeOpen
    },
    get codePlate() {
      return codePlate
    },
    set codePlate(v: CodePlate | null) {
      codePlate = v
    },
    get codeAim() {
      return codeAim
    },
    set codeAim(v: number) {
      codeAim = v
    },
    get codeJoining() {
      return codeJoining
    },
    get codeLooked() {
      return codeLooked
    },
    set codeLooked(v: number) {
      codeLooked = v
    },
    get codeTyped() {
      return codeTyped
    },
  }
}
