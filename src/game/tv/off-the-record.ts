// src/game/tv/off-the-record.ts — while TV is on, nothing is written down.
// DEV-483 (plan/FF-TV.md §4.0, "What it never does").
//
// An exhibition is five AI racers on a course the clock picked, watched by
// somebody who flew nothing. It must never post a lap, save a ghost, set a
// best, award a medal, or move a stat or a holotable. The plan's words: *"a
// mode that cannot record anything, not one that is tainted after the fact."*
//
// So this is a HOLD, taken by the mode and checked by the DOORS — every place
// the game writes a record checks it, and refuses while it is held:
//
//   · `game/personal-best.ts`'s `recordRun` — the best, and through it every
//     medal, completion mark and holotable (`mission-index.ts` derives all of
//     them from `readBest`; nothing else stores one);
//   · `game/ghost-store.ts`'s `keepLap` — the kept lap, the player's ghost;
//   · `net/lap-client.ts`'s `submitLap` and `submitRoomLap` — the lap server.
//
// A door, not a call site, because the call sites are wherever the next
// feature puts them: a hold on the store is what makes the mode unable to
// record, rather than a promise that the exhibition's code path happens not
// to reach the store today. (It does not reach it today: the local craft is
// never launched, so `boot/app.ts`'s finish block is unreachable — that is the
// first half of the argument and this is the second.)
//
// A count of holders rather than a flag, so two things that each hold it (an
// exhibition, and whatever DEV-480 makes of a live-race viewer later) cannot
// release each other's. Each `holdRecording` returns its own release, which is
// idempotent: a stop called twice releases once.
//
// Pure: module state and nothing else. No DOM, no three, no clock.

const holders = new Map<symbol, string>()

/**
 * Hold the record doors shut until the returned release is called. `why` is
 * for the console and the probes: who is holding it.
 */
export const holdRecording = (why: string): (() => void) => {
  const token = Symbol(why)
  holders.set(token, why)
  return () => {
    holders.delete(token)
  }
}

/** Is any hold on? Every record door asks this first. */
export const recordingHeld = (): boolean => holders.size > 0

/** Who holds it, for a probe. Empty when nobody does. */
export const recordingHeldBy = (): readonly string[] => [...holders.values()]
