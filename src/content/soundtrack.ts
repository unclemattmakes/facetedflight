// src/content/soundtrack.ts — the six tracks, and why these six.
//
// ── The decision ──────────────────────────────────────────────────────────
//
// **D31**, Matt 2026-09-13: *"let's go with holizna. pick six and wire them up."*
//
// [HoliznaCC0](https://freemusicarchive.org/music/holiznacc0/) releases everything under **CC0
// 1.0** — a public-domain dedication, not a licence with conditions. Nothing here is *required*:
// no attribution, no notice, no share-alike. That is the whole reason this source won. Everything
// below that looks like compliance is **courtesy**, and it is marked as such rather than dressed
// up as obligation, because a project that cannot tell the two apart will eventually get a real
// obligation wrong.
//
// ── Why THESE six, out of thirteen ────────────────────────────────────────
//
// Nobody on this side of the keyboard can hear them. What can be measured is **fit**, and 2016
// defined fit precisely: `PlaylistController` shuffles **without replacement** and **crossfades
// one track into the next over 2 s**. There is exactly ONE playlist — `int_01_hoverJet` references
// the mission bank's guid 13 times and the other three `MasterAudio*` prefabs zero — so every
// track can follow every other track, and the set has to hold together as a set.
//
// Two measurements decided it, taken over all thirteen at 22.05 kHz mono:
//
// **1. The head.** A track whose first two seconds sit far below its own body fades IN, and a 2 s
// crossfade onto a fade-in is a hole: the outgoing track is ramping down while the incoming one
// has not arrived. `Fires Uptown` (−58.7 dB) and `We used To Dance` (−54.0 dB) are disqualified by
// this alone, and `Dear Mr Super Computer` (−20.5 dB) with them. Every track below is ≥ −12.6 dB,
// and `Drama` at **+0.4 dB** is the best in the collection — it starts at full strength.
//
// **2. The spread.** Thirteen tracks span **10.0 dB** of body RMS. Shuffled at random that is a
// audible jump at transitions. These six span **6.0 dB**, which is one step of the player's own
// volume ladder (`src/audio/volume.ts`) — so the worst transition in the set is no larger than the
// smallest adjustment the player can make. The two quietest, darkest tracks (`Night Life` −15.1,
// `Cyber Anxiety` −12.6) would have made a lovely menu bank, and there is no menu bank to put them
// in; including them would have opened the spread to 9.6 dB.
//
// Beyond that, variety rather than sameness: **63 to 129 BPM** and a spectral centroid from 2148
// to 3316 Hz, so the pool is not one track six times.
//
// **Nothing is normalised.** The 6 dB spread is the artist's, and evening it out would be editing
// the work to fit a machine's preference. `lost-in-the-jungle` is also the only track in the
// collection whose last two seconds do NOT fade (−1.0 dB against its body), which makes it the one
// that crossfades out with full weight.
//
// ── What is NOT here ──────────────────────────────────────────────────────
//
// The `.opus` files. **Assets are not in git** (hard rule 7): they live under
// `public/assets/audio/music/`, which is gitignored, and reach a clone from R2 via
// `pnpm assets:pull`. `tools/assets/required-assets.json` carries a row per track with its bytes
// and sha256, so `pnpm assets:check --verify-hashes` verifies them by content.
//
// Transcoded from the artist's own `.ogg` at **128 kbps Opus VBR** — 18.7 MB for the set, fetched
// one track at a time and never all at once (`music.ts` decodes on demand and deliberately keeps
// no buffer cache: a decoded 3-minute stereo `AudioBuffer` is ~69 MB of raw float PCM). Each file
// carries title, artist, album, `license=CC0-1.0` and the dedication URI in its Opus comment
// block, so a file that travels alone still says where it came from.

import type { MusicTrack } from '@/audio/music'

/** Where the CC0 dedication can be read. Archived in `docs/private/licences/`. */
const CC0_URI = 'https://creativecommons.org/publicdomain/zero/1.0/'

const ARTIST = 'HoliznaCC0'

/**
 * `MusicTrack.src` is relative to the asset base (`VITE_ASSET_BASE_URL`), the same
 * as every other asset — so it is `/` in dev and the R2 origin in a build.
 */
const track = (id: string, title: string): MusicTrack => ({
  id,
  title,
  author: ARTIST,
  licence: 'CC0-1.0',
  licenceUri: CC0_URI,
  src: `assets/audio/music/${id}.opus`,
})

/**
 * The shipped soundtrack, in no particular order — the playlist shuffles without replacement, so
 * this order is only the order the pool is refilled in, never the order anything is heard.
 *
 * The comment on each is its measured character, not a judgement of it.
 */
export const SOUNDTRACK: readonly MusicTrack[] = [
  // −5.5 dB, 70 BPM, 130.6 s — the loudest and most driving of the thirteen.
  track('mutant-club', 'Mutant Club'),
  // −7.1 dB, 63 BPM, 162.2 s — the slowest here, and the only track in the
  // collection that does not fade out (tail −1.0 dB against its own body).
  track('lost-in-the-jungle', 'Lost In The Jungle'),
  // −7.7 dB, 70 BPM, 130.6 s — the brightest (centroid 3316 Hz).
  track('50-over-the-speed-limit', '50 Over The Speed Limit'),
  // −8.4 dB, 129 BPM, 197.5 s — the fastest.
  track('day-dreams', 'Day Dreams'),
  // −10.1 dB, 120 BPM, 222.9 s — the longest.
  track('retro-synths', 'Retro Synths'),
  // −11.5 dB, 115 BPM, 210.7 s — the best head in the collection, +0.4 dB: it
  // opens at full strength, so a crossfade onto it never dips.
  track('drama', 'Drama'),
]
