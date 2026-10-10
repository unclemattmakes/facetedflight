// src/render/title-vr.ts: ENTER VR's words, on the title. DEV-557; a row of
// the title's plate since DEV-558.
//
// Matt, 2026-10-01: *"let's get rid of the html curtain. it's confusing that
// the game can be fully functional, yet the curtain is still up. add an enter
// VR button to the title screen (or "connect vr headset" if it can't find
// one)".* And later the same day, the title as two rows: *"Start, Enter VR.
// Clicking either should take us to the Hangar"*.
//
// DEV-557 built this as a small plate BESIDE the title's rows, because the top
// page held four rows and four is the measured cap. DEV-558 took the title to
// two rows, so ENTER VR is a row now (`render/title-menu.ts`'s `enterVrRow`):
// the plate, its own hit test and its aim-walk (DOWN past the last row) went,
// and the rows' painter and picker are the one the stick, the keys, a head, a
// laser, a finger and the cursor already aim. What is left here is what the
// row SAYS, and whether it stands at all.
//
// ── Flat only ───────────────────────────────────────────────────────────
//
// In a headset you are already in VR, so the row is absent while presenting.
// On a phone with no headset it is absent too (`titleVrShown`): a phone has no
// headset to connect (DEV-557's call 2), so a phone's title is START alone.

/**
 * What the row says.
 *
 * - `enter`: the platform says a headset is there; a press asks for a session.
 * - `connect`: it says there is none (Matt's own words for it). A press asks
 *   again, and so does the platform's `devicechange`.
 * - `checking`: asking.
 * - `starting`: the session was asked for and has not answered.
 * - `needs-key`: a GAMEPAD pressed it. `requestSession` needs transient user
 *   activation, and a gamepad press is not an activation-triggering input in
 *   the HTML spec (a key, a click or a touch is), so the browser would refuse
 *   it. The row says what will work instead of failing quietly.
 * - `refused`: the browser or the runtime said no.
 * - `off`: `?xr=off`, a page that was told not to ask (it starts SteamVR on
 *   this kind of box). It never probes, so it cannot say there is no headset.
 */
export type TitleVrState =
  | 'enter'
  | 'connect'
  | 'checking'
  | 'starting'
  | 'needs-key'
  | 'refused'
  | 'off'

/** The row's two lines for a state. The label is Matt's words. */
export const titleVrText = (
  state: TitleVrState,
): { readonly label: string; readonly note: string } => {
  switch (state) {
    case 'enter':
      return { label: 'Enter VR', note: 'a headset is ready (or press H)' }
    case 'starting':
      return { label: 'Enter VR', note: 'starting the headset...' }
    case 'needs-key':
      return { label: 'Enter VR', note: 'a pad cannot: press H, or click' }
    case 'refused':
      return { label: 'Enter VR', note: 'it did not start; press again' }
    case 'checking':
      return { label: 'Connect VR headset', note: 'looking for one...' }
    case 'off':
      return { label: 'Connect VR headset', note: 'not looking: opened with xr=off' }
    default:
      return { label: 'Connect VR headset', note: 'plug one in, then press here (H)' }
  }
}

/**
 * Whether the row stands at all. Not in a headset (you are in VR), and not on
 * a touch device the platform says has no headset: a phone has nothing to
 * connect. A touch device that DOES report one (a headset's own browser) gets
 * it.
 */
export const titleVrShown = (o: {
  readonly presenting: boolean
  readonly touch: boolean
  readonly state: TitleVrState
}): boolean =>
  !o.presenting &&
  !(o.touch && o.state !== 'enter' && o.state !== 'starting' && o.state !== 'refused')
