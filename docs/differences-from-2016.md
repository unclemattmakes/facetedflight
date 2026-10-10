# Differences from the 2016 game

This edition is a port, not a remake: the flight model, the courses and the terrain generator
come from the original, and every tuning number is extracted from the original's data rather than
typed (see [content-as-data.md](content-as-data.md)). Where the port knowingly differs, or knowingly
keeps something that looks like a bug, it is recorded in the author's working notes. This page is
the summary a player or modder would want: the categories, and the changes you would notice.

Three words used below:

- **Kept**: the original's behavior, preserved on purpose, including defects.
- **Fixed**: the original's behavior, deliberately changed.
- **Added**: something the original did not have.

## Two editions, and what each one means

There are two **looks**, chosen in the options, and only the in-mission visuals change between
them.

- **Classic** is 2016 as the port reproduces it: no tone mapping, the original fog and no
  added haze, no cast shadows, and the original's terrain and sea.
- **Anniversary** is the updated look: tone mapping so highlights roll off instead of clipping,
  an aerial-perspective haze that cools and desaturates with distance, cast shadows, a glow on
  rings and the sun, finer facets on the terrain nearest the eye, moored boats and spectators on
  the shore, and solid, individually colored AI racers.

The **menus and the rules are the Anniversary edition's in both**. The original's rules are still
available behind a URL switch (`?rules=classic`), which the tests use.

## Kept on purpose

- **The HoverJet never levels itself.** A bank holds until the pilot takes it out. It shaped how
  the game feels and how players learned to fly it.
- **Fixed-step physics at the original's rate**, 81.967 Hz, the exact float the original stored.
- **The signature feel**: a per-step velocity edit between force accumulation and integration that
  bleeds sideways and vertical drift. This is why the simulation has no physics engine.
- **The terrain, bugs included.** The generator reproduces the original's mesh, including a
  quirk in how each quad picks its diagonal (it reads the wrong component, so the choice follows
  height rather than the map). It shows in the silhouette. Anniversary corrects the diagonal;
  Classic and the oracle tests keep the faithful one.
- **All thirteen missions, in the mode they shipped in**, with their original ring layouts,
  racing lines, trigger volumes and thresholds.
- **The JumpSeat as a second machine**, with its own physics and its own scoring, not a variant
  of the HoverJet.
- **Gravity of -32**, not -9.81, because every mass and thrust was tuned against it.
- **Boundary behavior**: where the original had a play-area boundary, there is one, with its
  original reset delay (13 seconds, not the 10 the source code suggests). Where the original had
  none (six of the thirteen missions), there is none.

## Fixed

- **Platinum on the first mission was impossible.** `rookie_01_hoverJet` had 16 rings worth 100
  each and a platinum threshold of 1,700. Platinum now means every ring, on every Ring Attack
  course, and gold stays at the original's ninety percent.
- **Medals are earned by performance.** In the original a straight line to the finish could
  out-score a lap that took the rings. A missed ring now forfeits the time bonus.
- **A mission that launched from the top of its own shaft** (`rookie_02_hoverJet`) now starts at
  the bottom like the others.
- **The boundary is enforced.** It had been extracted and then ignored, so you could fly to the
  horizon. It is a region sized per course, and, as in the original, it is an exit event: leaving
  starts the countdown, while a respawn point that already lies outside the region does not.
- **Fog on one mission was out of family.** `int_01_hoverJet`'s fog was far denser than the ten
  other missions that share a fog setting, and was thinned to match, by the author's eye.
- **Racers that stalled on a hairpin** or bounced off a palm now recover.

## Added, in every edition

- **A comfort block for headsets**: a vignette that narrows with angular rate (off, light or
  strong, light by default), a world-locked horizon band, quality presets, and a cockpit that is
  never rescaled or moved for framing. The original had none of these.
- **Touch controls** on a phone or tablet, and keyboard, mouse and gamepad support on a flat
  screen.
- **Flight School**: an instructor flies ahead of you and teaches the basics step by step, with no
  clock and no medal.
- **Quick Race.**
- **Multiplayer rooms**, a **course editor** with shareable courses, **Faceted Flight TV**, and
  **leaderboards** that rescore every submitted lap on the server (see [servers.md](servers.md)).
  The original's online leaderboards were tied to platforms that no longer apply.
- **Menus drawn in the world**, navigated with a ray from the controller or the pointer instead
  of the original's head-gaze cursor.

## Opponents

The original's racers were two recordings of the author's own flights. This edition replaces them
with **AI racers** that fly the same racing line using the same autopilot logic as the player's
practice proxy, so they respond to you and take the rings in order, and a race starts with five of
them on the grid. The recordings are still in the repository and still play with
`?opponents=ghosts`. Racers are solid, wear their own colors (a bright rainbow, with orange
reserved for you) and hit the same trees you do. Only a Ring Attack race has opponents, as in
2016; Target Practice and Free Flight do not.

## Rules in the Anniversary edition

- **Boost costs energy.** In the original, recharge outpaced burn so the tank never ran down and
  boost was effectively free. Now boost drains a tank, **passing through a ring refills it**,
  and an empty tank tapers rather than locking you out. The tank starts the run empty, and says
  READY, BOOST or EMPTY on the HUD. Classic rules keep the original's free boost.
- **Props can be broken.** The original had solid props in three of its four environments (about
  twelve thousand live colliders): a rock stood and flashed when you hit it. This edition keeps
  that collision and changes the response: hit one fast enough and it breaks, otherwise you
  bounce.
- **The AI treats the same collision as you do.**

## Added, in the Anniversary edition only

- **Aircraft variants**: the HoverJet in acrobat, standard and speed trims, expressed as
  multipliers on the original's numbers. Standard is bit-for-bit the 2016 aircraft, checked
  against a recording made before the variant layer existed. Leaderboards are per variant.
- **A glider**, a third aircraft with a course of its own.
- **Camera shake on a flat screen** for impacts and boosts, never in a headset session, and
  under the speed-effects comfort slider.
- A finer detail ring for the nearest terrain, a re-lit hangar, and the moored boats and crowds.

Variants and the glider currently appear only in the preview channel; the live site's production
channel hides them (see [architecture.md](architecture.md)).

## Cut from the original

- **Original multiplayer** (Photon and UNET). It barely shipped: one of its scenes did not exist
  in the project backup, and the player was always spawned in an offline mode. Replaced by rooms.
- **The original soundtrack and sound samples**, which came from third-party packs whose terms
  do not allow redistribution. Sound effects are synthesized in the browser; the soundtrack is
  six CC0 tracks.
- **Third-party scenery and hangar models** are rebuilt or absent in the open repository (see
  [assets.md](assets.md)); the live game uses licensed packs.
- **Platform leaderboards, analytics and the entitlement checks** of the original storefronts.
- **HOTAS support and the alternate control schemes** (b, c, d). Browsers report such devices with
  no semantic mapping; the standard gamepad mapping covers pads. Scheme a is the one ported.
- **The terrain LOD cross-fade.** The original's shader discarded the alpha that drove it, so the
  original hard-popped between levels too.
- **The unshipped content**: scenes the original had disabled and levels it never finished.

## How we check that a difference is a difference

Fidelity is measured where it can be, against something outside the port: the constants extracted
from the original's data, a terrain oracle that sweeps every chunk against the original's own
bake, structural assertions on the extracted levels, and recorded flights flown in tests. Where
the port is better for deviating, it deviates deliberately and says so. A difference with no
record is a bug.
