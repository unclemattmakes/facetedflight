# Making a trailer

The tooling that made the launch trailer: it captures footage from the running
game, then cuts it to music from an edit list. The working files (footage,
renders, stills) go to `$TRAILER_WORK`. Its default, set at the top of each
script, is a gitignored folder; the paths below write it as `$TRAILER_WORK`.

The launch trailer: 52 s, 1080p60, cut to `retro-synths`. Four 2-second
Classic shots from three environments under the Rift Arcade quote, a wipe from
Classic to Anniversary on the music's drop, the countdown, a montage of ten
courses with five cards (missions, AI racers, online, FF-TV, the editor), and
the title screen's logo and flypast as the end card with `facetedflight.net`.

## What you need

A checkout that runs the end-to-end suite (`public/assets/` pulled, Playwright
installed), and `ffmpeg` on the `PATH`. The scripts are bash; on Windows, run
them from Git Bash.

## Quick start

All from the repo root.

| Want | Run |
|---|---|
| Re-cut (no new footage) | edit `tools/trailer/edl.json`, then `node tools/trailer/build.mjs` (add `--draft` for a fast encode) |
| New footage | add a shot to `tools/trailer/shots.json`, then `bash tools/trailer/capture.sh <shot>[,<shot>...]` |
| Pick in-points | `bash tools/trailer/sheet.sh <shot> [step]`, then look at `$TRAILER_WORK/stills/sheet-<shot>.jpg` |
| The logo, transparent | `bash tools/trailer/logo.sh`, writes `$TRAILER_WORK/logo.png` |
| Reproduce the launch trailer | `bash tools/trailer/capture.sh $(node -p "require('./tools/trailer/shots.json').map(s=>s.name).join(',')")`, `bash tools/trailer/logo.sh`, `node tools/trailer/build.mjs` |

A full re-capture of the launch trailer's shots took about 25 minutes. A
re-cut takes about 3. The footage is about 300 MB per 10 s of shot (JPEG
frames).

Output: `$TRAILER_WORK/out/trailer.mp4`. For a smaller copy to share
(the 52 s master is about 130 MB), a two-pass encode:

```bash
ffmpeg -i trailer.mp4 -c:v libx264 -preset slow -b:v 4000k -maxrate 4500k -bufsize 9000k -pass 1 -an -f null /dev/null
ffmpeg -i trailer.mp4 -c:v libx264 -preset slow -b:v 4000k -maxrate 4500k -bufsize 9000k -pass 2 -c:a aac -b:a 160k -movflags +faststart trailer-share.mp4
```

## The pipeline

1. **Capture** (`capture.spec.ts`, run by `capture.sh`). Each shot boots the
   game the way the e2e specs do (autopilot mission, FF-TV exhibition, title,
   or editor) and records it as numbered JPEGs plus an ffmpeg concat list.
   The spec is copied into `tests/e2e/` for the run (beside the fixtures it
   imports, gitignored by its `_` prefix) and removed on exit.
2. **Choose** (`sheet.sh`). A contact sheet per shot with game time burned in;
   every in-point in `edl.json` was read off one of these.
3. **Cut** (`build.mjs` + `edl.json`). Each shot is trimmed and re-timed to
   exactly 60 fps, wipes and dissolves are applied, then cards (`drawtext` in
   CRYSTAL, the game's UI face), image overlays (the logo bug), fades and the
   spliced music.

### Virtual time, and why

Real-time capture of this game drops frames, and nothing tells you which:
MediaRecorder on the canvas kept 294 of 361 frames in flight even when the page
was throttled to give it room, and the CDP screencast's pacing follows the
compositor. So `capture.spec.ts` installs an init script that owns the page's
clock. Once recording starts, `requestAnimationFrame` callbacks run only from
its own pump, `performance.now()` returns exactly `frames / 60` s past the
start, each frame is copied to an `OffscreenCanvas` while its drawing buffer is
still valid, and the pump waits until Node has written that JPEG before the
next frame. Every shot of the launch trailer ended `N frames, 0 missing`. The
game's code is untouched: the sim already runs a fixed step from whatever dt it
is given, so a steady 1/60 s gives it a steady game.

`rec: "screen"` (CDP screencast, real time) is the other mode, for anything
whose look is DOM: the editor's panels are DOM and a canvas grab would drop
them. It ran at about 25 fps on the editor; the concat list carries real
durations, so it plays at the right speed.

## edl.json

```jsonc
{
  "length": 52,             // seconds; the end is trimmed to this
  "fadeIn": 0.5, "fadeOut": 1.5,
  "music": { "file": "public/assets/audio/music/retro-synths.opus",
             "ranges": [[8, 48], [196, 212]],   // source seconds, spliced in order, 60 ms crossfade
             "fadeOut": 3, "gain": 1 },
  "overlays": [ { "file": "<TRAILER_WORK>/logo.png", "at": 0.3, "to": 9.8,
                  "w": 230, "x": 1640, "y": 846, "fade": 0.5, "opacity": 0.95 } ],
  "shots": [
    { "clip": "c3-alpine", "in": 3.3, "dur": 2 },          // `in` is GAME seconds into the clip
    { "clip": "editor2", "in": 1, "dur": 4, "speed": 1.5 },
    { "clip": "a-cockpit-simonet", "wipeFrom": "c-cockpit", // matched wipe: both clips at the same game time
      "in": 6.0, "dur": 4, "wipeAt": 2, "wipe": 1 },        // wipe ends `wipeAt` s into the shot
    { "clip": "x", "in": 0, "dur": 2, "dissolve": 0.5 }     // cross-dissolve INTO this shot
  ],
  "cards": [ { "text": "Ten years later", "at": 4.3, "to": 7.5,
               "y": "h*0.14", "size": 72, "color": "white", "fade": 0.4 } ]
}
```

Shot fields (`shots.json`) are documented on the `Shot` interface in
`capture.spec.ts`: `kind`, `mission`, `course`, `query`, `from`, `dur`, `rec`,
`keys`, `clicks`, `drags`, `hide`, `prep`.

## The music

Six cues in `public/assets/audio/music/`. What made `retro-synths` the pick,
measured rather than listened to (a per-second RMS and onset envelope, and an
autocorrelation tempo, both through ffmpeg into node):

- **120 BPM exactly, bars on even seconds.** Cuts on 2 s (or 1 s) land on the beat.
- **A quiet intro, then the full mix at exactly 16.00 s.** The launch trailer
  starts the music at 8 s so the drop lands at trailer 8.0; from 0 s the
  opening was slow.
- **A lighter section from 196 s that fades to the end.** The end card runs
  over it; the splice from 48 s to 196 s keeps the downbeat.

Other cues for next time: `day-dreams` (88 BPM, quiet until 15 s, a breakdown
at 89 s), `drama` (115 BPM, 8-second breakdowns at 50 s and 91 s, which suit
a mid-trailer beat).

## Lessons, in the order they cost time

**The player's ship needs `&camera=third`, never `&view=chase`.** `view=chase`
is a developer spectator camera: `thirdPersonLive` is false there, so the ship
keeps its cockpit art, with an open canopy and no engine particles.
`camera=third` is the game's own CHANGE VIEW, with the exterior hull.
`&view=chase&chase=fast` (follow the leading AI racer) is fine, because racers
always wear the exterior.

**Classic and Anniversary third-person are different cameras, so a matched wipe
has to be in the cockpit.** Classic uses 2016's own chase camera (far back,
wide) and Anniversary uses the spring arm (close behind), so the framings never
line up. In the cockpit both editions frame identically. The autopilot is
deterministic and virtual time feeds it identical dts, so two runs of one course
match; align them by each clip's `startClock` (in `clips/<name>.json`): the poll
that waits for `from` overshoots by a different few hundredths each run, and one
pair was 0.54 s apart.

**On Classic, `camera=third` is the "same follow angle" for free.** 2016's chase
camera on every Classic shot made the opening read as one place in four
environments.

**The autopilot does not fly Free Flight.** On `hoverJet_kauai_beg` it sits on
the pad. Holding Space launched the jet off the pad, which then coasted to a
stop, so Space is not the throttle; two seconds of that skim was the Kauai shot.
To get more, find the throttle key in `src/input/` first.

**Pick in-points from a contact sheet, not by reasoning.** `sheet.sh` at 0.5 s
steps found every gate burst. For an exact beat (GO on the countdown) crop the
readout at 0.1 s steps: GO showed at 15.65 s, not the 15.5 the 0.5 s sheet
suggested.

**Some chase shots clip into terrain.** The Desert canyon put the camera inside
the walls for whole seconds (black frames). Look at the sheet before choosing.

**The title screen.** Hide `title-menu` (`"hide": ["title-menu"]`) for a clean
logo; the DOM credit line and badge are not in a canvas capture. The jet
flypast crosses about 6.0 to 6.8 s and 12.8 to 13.8 s after the first press,
and loops.

**The logo on transparency took three tries.** Hiding everything but
`title-logo` in the running title over a green background drew nothing where
the logo was (the logo object was visible and on the camera's layers; cause not
established). A difference matte (title with and without the logo) carried the
logo's glow on the trees around it. What worked is `logo.html`: the glb alone,
painted with `paintLogo`'s values, on a transparent canvas. Its face points
down -z, so the camera sits at `side=-1`; `side=1` reads mirrored.

**The editor: show the course being drawn.** A static desk is an island with a
dot on it. Clicks on the island place points (each followed by Escape, as
`editor-pad.spec.ts` does), and eight clicks 0.8 s apart drew a ring loop
around the valley.

**One capture at a time.** Two runs on one port share a dev server, and one
tears it down under the other ("Failed to fetch" mid-shot). `capture.sh` pins
`E2E_PORT` (default 5397); give a second run its own.

**ffmpeg traps.** `cropdetect` on an alpha channel prints nothing (find bounds
in node over `alphaextract` raw bytes, as `logo.spec.ts` does). An
`execFileSync` reading raw frames needs `maxBuffer`. In `drawtext`, a `'` ends
the quoted text (`build.mjs` swaps it for a typographic one) and a `:` needs
escaping; straight `"` is fine. White cards over a bright sky need the
`borderw` outline `build.mjs` adds.
