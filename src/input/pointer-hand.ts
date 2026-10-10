// src/input/pointer-hand.ts — WHICH hand's laser aims the menus. DEV-321.
//
// Matt, 2026-09-23: *"laser pointer from motion controller plz"* (NEXT.md #40).
//
// ── What was already there, and what this adds ────────────────────────────
//
// Nothing about PICKING changes. `flight.pause.pick` and `hangar.gaze` both take
// an arbitrary world ray, and the confirm that commits what they picked is
// device-blind: A, Enter, a tap, a mouse click (DEV-301) and the XR `select`
// (DEV-205) all ride one `confirm`, and `hangar.choose()` sits downstream of it
// with no device branch at all. The head aimed that ray in a session (DEV-199).
// A motion controller's target ray is one more thing to aim it with.
//
// So the work is the RAY (`render/xr-pointer.ts`) and one decision, which is
// this file: with two hands and a head, which one aims?
//
// ── The rule ──────────────────────────────────────────────────────────────
//
// > **One aimer at a time. A hand that has a pose aims; the head aims only when
// > no hand does. The hand is the RIGHT one until you pull the other trigger,
// > and the pull that moves the laser is spent on moving it.**
//
// *One aimer.* A head that aimed whenever the laser missed would move the
// selection to wherever you happened to be looking the moment you lowered your
// hand — the hover lights on a table the beam is not pointing at, and the
// trigger boards it. What you see highlighted has to be what the beam touches.
//
// *The right hand by default*, because scheme "a" puts the commit there already
// (right A, `input/xr.ts`) and the left hand's reachable buttons are the D-pad
// that opens the plate. Not handedness as a preference — just the hand the
// controls already point at.
//
// *The other trigger moves the laser* — SteamVR's dashboard and the Quest
// system UI both work this way, so it is what anyone holding these controllers
// already expects. And **that pull does not also commit**, which is the safety
// half, not tidiness: the alternative confirms whatever the OTHER hand was
// resting on — an EXIT row under a hand in your lap. It is DEV-301's rule in
// another form: *the click that captures the pointer is spent on the capture.*
//
// *Only while something can be aimed at.* A trigger pull in flight is the
// throttle (right) or the boost (left); if pulls moved the laser there, the
// hand you last boosted with would own it when the plate came up, and your first
// pull on the plate would be spent taking it back. So outside a menu a pull is
// spent WITHOUT moving anything — the latch rule `input/xr-select.ts` states
// for the same reason: an event that sat in a buffer would be delivered the
// moment somebody paused.
//
// ── What is NOT a pointer ─────────────────────────────────────────────────
//
// Only `targetRayMode === 'tracked-pointer'`: a controller, or a tracked hand.
// A `transient-pointer` (Apple Vision Pro's pinch — the device with no sticks
// `input/xr.ts` already worries about) exists only for the length of the pinch
// and its ray IS the user's gaze at pinch start, so it has nothing to aim with
// between pinches; `gaze` and `screen` modes are the head and a finger. All of
// those keep the head aiming, which is DEV-199's pointer unchanged.
//
// **No "has it moved" gate.** A tracked controller is a controller in a hand —
// a still one on a desk is also one you cannot pull a trigger on — and a gate
// would add a second invisible switch between two aimers. The rule stays one
// sentence.
//
// ── Keyed by HANDEDNESS, never by input-source object ─────────────────────
//
// The Frame's controllers arrive and are immediately REPLACED — an
// `inputsourceschange +2 -2` one tick later (`input/xr-select.ts` has the
// reading). Anything keyed on the source object would be stranded by that swap;
// a handedness string survives it. The listener is on the SESSION for the same
// reason.

/** The two hands a laser can come from. */
export type PointerHand = 'left' | 'right'

/** The hand that points until the other trigger is pulled. See the header. */
export const DEFAULT_POINTER_HAND: PointerHand = 'right'

/** An `XRInputSourceEvent`, narrowed to what this file may look at. */
export interface PointerPullEvent {
  readonly inputSource?: {
    readonly handedness?: string
    readonly targetRayMode?: string
  }
}

/**
 * The part of an `XRSession` this needs. Structural, so a test can hand in a
 * fake: there is no headless WebXR worth maintaining (CLAUDE.md).
 */
export interface PointerPullSource {
  addEventListener(type: 'select', listener: (event: PointerPullEvent) => void): void
  removeEventListener(type: 'select', listener: (event: PointerPullEvent) => void): void
}

export interface PointerArbiter {
  /**
   * Point it at the live session, every frame — exactly as `xrSelect.follow`
   * is. The same session is a no-op; a different one (or null) drops the old
   * listener, anything it had latched, and the hand you had chosen.
   */
  follow(session: PointerPullSource | null): void
  /**
   * Spend this frame's trigger pulls. **Call once a frame, every frame**, and
   * bind the result to a name — never inline in an `||`, for `xr-select.ts`'s
   * reason.
   *
   * @param wanted a menu is up that the laser can aim at.
   * @param posed the hands with a target-ray pose this frame.
   * @returns true when a pull was SPENT moving the laser to the other hand —
   *   the caller must not let that same pull confirm anything.
   */
  take(wanted: boolean, posed: ReadonlySet<PointerHand>): boolean
  /**
   * Which hand aims this frame, or null for the head. The preferred hand if it
   * has a pose, else the other if IT has one — a controller that has gone to
   * sleep hands the laser over rather than leaving the menu unaimable, and
   * takes it back when it wakes, because the preference did not move.
   */
  choose(posed: ReadonlySet<PointerHand>): PointerHand | null
  /** The hand that points when both can. */
  readonly preferred: PointerHand
  dispose(): void
}

const other = (hand: PointerHand): PointerHand => (hand === 'left' ? 'right' : 'left')

const asHand = (handedness: string | undefined): PointerHand | null =>
  handedness === 'left' || handedness === 'right' ? handedness : null

export const createPointerArbiter = (): PointerArbiter => {
  let attached: PointerPullSource | null = null
  let preferred: PointerHand = DEFAULT_POINTER_HAND
  // Which hands pulled since the last `take`. Two booleans rather than a set,
  // so a frame allocates nothing.
  let pulledLeft = false
  let pulledRight = false

  // ONE listener for the life of the arbiter, for the reason `xr-select.ts`
  // gives: a fresh closure per attach leaks one per session.
  const onSelect = (event: PointerPullEvent): void => {
    const source = event.inputSource
    // Only a tracked pointer moves the laser. A transient pointer's pull is a
    // commit and nothing else — see the header.
    if (source?.targetRayMode !== 'tracked-pointer') return
    const hand = asHand(source.handedness)
    if (hand === 'left') pulledLeft = true
    else if (hand === 'right') pulledRight = true
  }

  const choose = (posed: ReadonlySet<PointerHand>): PointerHand | null => {
    if (posed.has(preferred)) return preferred
    const alt = other(preferred)
    return posed.has(alt) ? alt : null
  }

  const detach = (): void => {
    if (attached) attached.removeEventListener('select', onSelect)
    attached = null
    pulledLeft = false
    pulledRight = false
    // A new session starts on the default hand: the choice belonged to the
    // session that made it, and a headset taken off and handed to someone else
    // is a new player.
    preferred = DEFAULT_POINTER_HAND
  }

  return {
    follow(session) {
      if (session === attached) return
      detach()
      if (session) {
        session.addEventListener('select', onSelect)
        attached = session
      }
    },
    take(wanted, posed) {
      const left = pulledLeft
      const right = pulledRight
      // Spent whether or not anything comes of it — see the header.
      pulledLeft = false
      pulledRight = false
      if (!wanted) return false
      const pointing = choose(posed)
      // The head is aiming: no hand has a pose to move the laser to, and a pull
      // is a plain commit.
      if (pointing === null) return false
      // The pointing hand's own pull is the commit it looks like.
      if (pointing === 'left' ? left : right) return false
      const alt = other(pointing)
      const altPulled = alt === 'left' ? left : right
      // Only to a hand that can aim. A pull from a hand with no pose has no ray
      // to hand the laser to, so it stays a commit.
      if (!altPulled || !posed.has(alt)) return false
      preferred = alt
      return true
    },
    choose,
    get preferred() {
      return preferred
    },
    dispose() {
      detach()
    },
  }
}
