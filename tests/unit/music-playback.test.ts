// tests/unit/music-playback.test.ts — the soundtrack plays, and it plays at a
// constant loudness through the fade.
//
// **No licensed audio is involved and none may become involved.** The tracks
// below are fixtures with invented ids; the "decoded buffer" is whatever
// `RecordingBackend.loadMusic` hands back, which is the same seam `backend.ts`
// exists to provide (the unit suite runs in node with no `AudioContext`, D7);
// and the one place a real signal is needed — proving the crossfade holds its
// loudness — synthesizes two uncorrelated noise signals here in the file and
// measures their RMS. That is the house idiom: the SFX are synthesized, so the
// music test synthesizes too.
//
// What is asserted, and why each one is the assertion rather than a neighbour:
//
//  1. **The crossfade geometry**, against dB and against a real signal — not
//     against the numbers the implementation would produce. `crossfadeGains` is
//     pure, so t=0 / midpoint / t=end are checkable directly, and the claim in
//     its header ("linear drops 3 dB in the middle") is checked by building the
//     linear pair and measuring the hole. A test that only asserted
//     `cos(π/4) === 0.7071` would agree with any curve anyone typed.
//  2. **The shuffle refills**, over two full cycles — every track before any
//     repeat, which is the property `PlaylistController.cs:657-659` has.
//  3. **The two start moments**, through `AudioSystem.event()` rather than by
//     calling the playlist: the wiring is the part with no other coverage.
//  4. **Mute, `?audio=off`, and a 404**, because "the game keeps booting" is
//     the requirement the soundtrack is allowed to fail.

import { describe, expect, it, vi } from 'vitest'
import { createAudioSystem } from '@/audio'
import { createRecordingBackend, createSilentBackend, type RecordingBackend } from '@/audio/backend'
import { gainToDb, MASTER_MUSIC, MUSIC_CROSSFADE_SECONDS, MUSIC_GO_FADE_SECONDS } from '@/audio/mix'
import {
  bankCrossfadeSeconds,
  createMusicPlaylist,
  crossfadeGains,
  equalPowerCurve,
  MUSIC_CUT_SECONDS,
  type MusicScheduler,
  type MusicTrack,
  nextShuffled,
} from '@/audio/music'
import { musicGainFor } from '@/audio/volume'
import { lcg } from './helpers/seeded'

// ── fixtures ────────────────────────────────────────────────────────────────

/** Fixture tracks. Invented, unlicensed, and never fetched by anything here. */
const fixture = (id: string): MusicTrack => ({
  id,
  title: `fixture ${id}`,
  author: 'test fixture — no audio exists for this entry',
  licence: 'NOT-A-LICENCE',
  licenceUri: 'about:blank',
  src: `assets/audio/music/${id}.opus`,
})

const THREE = [fixture('a'), fixture('b'), fixture('c')] as const

/** A [0,1) source that walks a fixed list, so every pick is assertable. */
const sequenceRandom = (values: readonly number[]): (() => number) => {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

/**
 * Drain the microtask queue.
 *
 * The load path is `loadMusic()` (async) -> `.then(...)`, and the failure path
 * recurses through as many of those as there are tracks. One macrotask tick
 * runs after ALL of them, including the ones enqueued by the ones before —
 * which a fixed number of `await Promise.resolve()` does not.
 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A scheduler that never fires on its own. `run()` fires the pending handoff. */
const manualScheduler = (): {
  readonly scheduler: MusicScheduler
  readonly pendingSeconds: () => number | null
  run: () => void
} => {
  let pending: { callback: () => void; seconds: number } | null = null
  return {
    scheduler: (callback, seconds) => {
      pending = { callback, seconds }
      return () => {
        pending = null
      }
    },
    pendingSeconds: () => pending?.seconds ?? null,
    run: () => {
      const p = pending
      pending = null
      p?.callback()
    },
  }
}

const musicCalls = (backend: RecordingBackend) =>
  backend.calls.filter((c) => c.call.startsWith('music'))

// ── 1. the geometry ─────────────────────────────────────────────────────────

describe('the crossfade is equal-power, so the loudness is flat across it', () => {
  it('is (1, 0) at the start, (0, 1) at the end and equal at the midpoint', () => {
    const seconds = MUSIC_CROSSFADE_SECONDS
    expect(seconds).toBe(2)

    const start = crossfadeGains(0, seconds)
    expect(start.outgoing).toBeCloseTo(1, 12)
    expect(start.incoming).toBeCloseTo(0, 12)

    const middle = crossfadeGains(1, seconds)
    expect(middle.outgoing).toBeCloseTo(Math.SQRT1_2, 12)
    expect(middle.incoming).toBeCloseTo(Math.SQRT1_2, 12)

    const end = crossfadeGains(2, seconds)
    expect(end.outgoing).toBeCloseTo(0, 12)
    expect(end.incoming).toBeCloseTo(1, 12)
  })

  it('holds total POWER at 1 across the whole fade, not total amplitude', () => {
    // A sweep rather than three points: the identity being checked
    // (`cos² + sin² = 1`) is supposed to hold everywhere, and a curve that is
    // right at 0, 0.5 and 1 and wrong at 0.3 is exactly the shape of bug a
    // three-point check cannot see (CLAUDE.md: a spot-check is a smoke test).
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * MUSIC_CROSSFADE_SECONDS
      const { outgoing, incoming } = crossfadeGains(t, MUSIC_CROSSFADE_SECONDS)
      expect(outgoing ** 2 + incoming ** 2).toBeCloseTo(1, 10)
      // And the amplitudes do NOT sum to 1 anywhere but the ends, which is the
      // difference from 2016's curve stated as a positive claim.
      if (i > 0 && i < 64) expect(outgoing + incoming).toBeGreaterThan(1)
    }
  })

  it('is the reason not to use the linear pair: that one is 3.01 dB down in the middle', () => {
    // `PlaylistController.cs:368-369` — `ratio` and `1 - ratio`, two amplitudes.
    // The quantity is POWER, and `gainToDb` knows nothing about this feature,
    // so this is an independent measurement of the hole rather than a restated
    // belief about it.
    const linearPower = 0.5 ** 2 + 0.5 ** 2
    expect(gainToDb(Math.sqrt(linearPower))).toBeCloseTo(-3.01, 2)

    const equal = crossfadeGains(1, 2)
    const equalPower = equal.outgoing ** 2 + equal.incoming ** 2
    expect(gainToDb(Math.sqrt(equalPower))).toBeCloseTo(0, 6)
  })

  it('keeps the RMS of two real signals flat, where the linear pair loses a third of it', () => {
    // The algebra above says the power is constant. This says it about a
    // SIGNAL: two uncorrelated noise sources, mixed at the two gain pairs, with
    // the RMS measured rather than derived. Uncorrelated is the load-bearing
    // word — two copies of the SAME signal would sum in amplitude and the
    // linear pair would be the correct one, which is why a crossfade between
    // two different songs is not the same problem as a fade of one.
    const n = 8192
    const randA = lcg(0x9e3779b9)
    const randB = lcg(0x85ebca6b)
    const a = Array.from({ length: n }, () => randA() * 2 - 1)
    const b = Array.from({ length: n }, () => randB() * 2 - 1)

    const rms = (x: number, curve: 'equal' | 'linear'): number => {
      const gains =
        curve === 'equal'
          ? crossfadeGains(x * MUSIC_CROSSFADE_SECONDS, MUSIC_CROSSFADE_SECONDS)
          : { outgoing: 1 - x, incoming: x }
      let sum = 0
      for (let i = 0; i < n; i++) {
        const sample = (a[i] ?? 0) * gains.outgoing + (b[i] ?? 0) * gains.incoming
        sum += sample * sample
      }
      return Math.sqrt(sum / n)
    }

    const reference = rms(0, 'equal')
    // Flat within 2 % across the fade — the residual is the finite sample, not
    // the curve.
    for (let i = 0; i <= 8; i++) {
      expect(rms(i / 8, 'equal') / reference).toBeCloseTo(1, 1)
    }
    // And the linear pair really does lose the 3 dB in the middle: 10^(-3.01/20)
    // = 0.7071 of the amplitude, i.e. about 29 % quieter.
    expect(rms(0.5, 'linear') / reference).toBeCloseTo(Math.SQRT1_2, 1)
  })

  it('samples the same curve for `setValueCurveAtTime`, endpoints exact', () => {
    // Float32Array, so ~7 significant digits and no more: `setValueCurveAtTime`
    // takes a `Float32Array` and this is the value the audio thread will
    // actually read, not the double it was computed from.
    const up = equalPowerCurve('in', 65)
    const down = equalPowerCurve('out', 65)
    expect(up.length).toBe(65)
    expect(up[0]).toBeCloseTo(0, 7)
    expect(up[64]).toBeCloseTo(1, 7)
    expect(down[0]).toBeCloseTo(1, 7)
    expect(down[64]).toBeCloseTo(0, 7)
    expect(up[32]).toBeCloseTo(Math.SQRT1_2, 7)
    for (let i = 1; i < 65; i++) {
      expect(up[i] ?? 0).toBeGreaterThan(up[i - 1] ?? 1)
      expect(down[i] ?? 1).toBeLessThan(down[i - 1] ?? 0)
    }
  })

  it('takes its length from the BANK: 2 s mission, 1 s menu', () => {
    expect(bankCrossfadeSeconds('mission')).toBe(2)
    expect(bankCrossfadeSeconds('menu')).toBe(1)
    expect(createMusicPlaylist().crossfadeSeconds).toBe(2)
    expect(createMusicPlaylist({ bank: 'menu' }).crossfadeSeconds).toBe(1)
    // The menu bank's midpoint is half a second in, not one second — the SAME
    // curve on a shorter clock, which is what "the bank owns the length" means.
    const menu = crossfadeGains(0.5, bankCrossfadeSeconds('menu'))
    expect(menu.outgoing).toBeCloseTo(Math.SQRT1_2, 12)
    expect(menu.incoming).toBeCloseTo(Math.SQRT1_2, 12)
  })
})

// ── 2. the shuffle ──────────────────────────────────────────────────────────

describe('shuffle is without replacement and refills on loop', () => {
  it('plays every track before any repeat, twice over', () => {
    const random = lcg(12345)
    let remaining: readonly MusicTrack[] = THREE
    const drawn: string[] = []
    for (let i = 0; i < 6; i++) {
      const step = nextShuffled(THREE, remaining, random)
      remaining = step.remaining
      expect(step.chosen).not.toBeNull()
      drawn.push(step.chosen?.id ?? '?')
    }
    expect(new Set(drawn.slice(0, 3))).toEqual(new Set(['a', 'b', 'c']))
    expect(new Set(drawn.slice(3, 6))).toEqual(new Set(['a', 'b', 'c']))
  })

  it('refills BEFORE it picks, so a three-track playlist never plays two and stops', () => {
    // `:658-659` runs inside the previous `RemoveRandomClip`, so an empty pool
    // at the top of `:615` cannot happen with `loopPlaylist: 1`. Asserted from
    // the empty pool directly, which is the state that would otherwise return
    // null.
    const step = nextShuffled(THREE, [], sequenceRandom([0]))
    expect(step.chosen?.id).toBe('a')
    expect(step.remaining).toHaveLength(2)
  })

  it('stops at the end with `loop` false, and with no tracks at all', () => {
    expect(nextShuffled(THREE, [], sequenceRandom([0]), false).chosen).toBeNull()
    expect(nextShuffled([], [], sequenceRandom([0])).chosen).toBeNull()
  })

  it('DEV-423: `avoid` skips a track without spending it, and yields when it is all there is', () => {
    const [a, b] = THREE
    // A refill with the sounding track to avoid: random 0 would take index 0,
    // which is `a` — so it lands on the first track that is NOT `a`, and `a`
    // stays in the pool for a later pick rather than being thrown away.
    const step = nextShuffled(THREE, [], sequenceRandom([0]), true, a)
    expect(step.chosen?.id).toBe('b')
    expect(step.remaining.map((t) => t.id)).toEqual(['a', 'c'])
    // The last one left IS the one to avoid: a one-song soundtrack still plays.
    expect(nextShuffled(THREE, [b as MusicTrack], sequenceRandom([0]), true, b).chosen?.id).toBe(
      'b',
    )
    expect(nextShuffled([a as MusicTrack], [], sequenceRandom([0.9]), true, a).chosen?.id).toBe('a')
  })
})

// ── 3. playback, through the recording backend ──────────────────────────────

describe('a track under the lift, and a different one on GO', () => {
  const build = (random: () => number) => {
    const backend = createRecordingBackend()
    const timer = manualScheduler()
    const music = createMusicPlaylist({
      backend,
      random,
      scheduler: timer.scheduler,
      warn: () => {},
    })
    backend.setMusicSeconds(120)
    music.setTracks(THREE)
    return { backend, music, timer }
  }

  it('fetches, decodes and fades in over the bank crossfade — `fadeInFirstSong: 1`', async () => {
    const { backend, music } = build(sequenceRandom([0]))
    music.start('lift')
    // Synchronous: the pick is immediate so the API is honest about what is
    // queued, and NOTHING has been fetched or started yet.
    expect(music.playing?.id).toBe('a')
    expect(backend.musicVoices).toHaveLength(0)

    await flush()
    expect(backend.musicVoices.map((v) => v.src)).toEqual(['assets/audio/music/a.opus'])
    expect(musicCalls(backend)).toContainEqual({
      call: 'musicFadeIn',
      voice: 1,
      src: 'assets/audio/music/a.opus',
      seconds: MUSIC_CROSSFADE_SECONDS,
    })
  })

  it('does not stack a second voice when the lift cue arrives twice', async () => {
    const { backend, music } = build(sequenceRandom([0, 0.5]))
    music.start('lift')
    music.start('lift')
    await flush()
    music.start('lift')
    await flush()
    expect(backend.musicVoices).toHaveLength(1)
    expect(backend.calls.filter((c) => c.call === 'musicStart')).toHaveLength(1)
  })

  it('GO carries the pool on, cuts the lift track and brings a new one out of silence over 1 s', async () => {
    // 0 picks index 0 of 3 ('a'); 0.5 picks index 1 of what is LEFT, ['b','c']
    // ('c'). 2016 re-seeded here and would have picked index 1 of all three
    // ('b') — DEV-423 carries the pool on instead.
    const { backend, music } = build(sequenceRandom([0, 0.5]))
    music.start('lift')
    await flush()
    backend.clear()

    music.start('go')
    expect(music.playing?.id).toBe('c')
    await flush()

    const calls = musicCalls(backend)
    // The outgoing is cut, not crossfaded: 2016 puts the playlist volume at
    // zero on the same frame (`Timer_Race.cs:76`), so this is a de-click.
    expect(calls).toContainEqual({
      call: 'musicFadeOut',
      voice: 1,
      src: 'assets/audio/music/a.opus',
      seconds: MUSIC_CUT_SECONDS,
    })
    expect(calls).toContainEqual({
      call: 'musicFadeIn',
      voice: 2,
      src: 'assets/audio/music/c.opus',
      seconds: MUSIC_GO_FADE_SECONDS,
    })
    expect(MUSIC_GO_FADE_SECONDS).toBe(1)
    expect(backend.musicVoices.map((v) => v.src)).toEqual(['assets/audio/music/c.opus'])
  })

  // ── DEV-423: "start a new song once the race starts" ──────────────────
  //
  // Under 2016's re-seed these two go red the way Matt heard it: a random
  // source of 0 takes index 0 of the refilled pool, which is the lift's own
  // song, every time.

  it('DEV-423: GO never brings back the song the lift is playing', async () => {
    const { backend, music } = build(() => 0)
    music.start('lift')
    await flush()
    expect(music.playing?.id).toBe('a')
    backend.clear()

    music.start('go')
    await flush()
    expect(music.playing?.id).not.toBe('a')
    const started = musicCalls(backend).filter((c) => c.call === 'musicStart')
    expect(started.map((c) => ('src' in c ? c.src : ''))).toEqual(['assets/audio/music/b.opus'])
  })

  it('DEV-423: race after race, every track before a repeat and never the same one twice running', async () => {
    // The shape of an evening: the lift track, then GO; the next race's lift
    // finds music already playing (`'lift'` is idempotent) and only GO moves.
    // A constant random is the adversarial source — it would pick index 0 of a
    // re-seeded pool, the song already sounding, on every single GO.
    const { music } = build(() => 0)
    music.start('lift')
    await flush()
    const heard: string[] = [music.playing?.id ?? '?']
    for (let race = 0; race < 7; race++) {
      music.start('lift') // the next ride: already playing, so nothing
      music.start('go')
      await flush()
      heard.push(music.playing?.id ?? '?')
    }
    for (let i = 1; i < heard.length; i++) {
      expect(heard[i], `race ${i}: ${heard.join(' ')}`).not.toBe(heard[i - 1])
    }
    // The lift's song and the first two GOs are the whole soundtrack.
    expect(new Set(heard.slice(0, 3))).toEqual(new Set(['a', 'b', 'c']))
  })

  it('DEV-423: never twice running under a real shuffle either, over a long evening', async () => {
    const { music } = build(lcg(2026))
    music.start('lift')
    await flush()
    let last = music.playing?.id
    for (let race = 0; race < 60; race++) {
      music.start('go')
      await flush()
      expect(music.playing?.id, `race ${race}`).not.toBe(last)
      last = music.playing?.id
    }
  })

  it('schedules the handoff `crossfadeSeconds` before the end, and leaves ONE voice after it', async () => {
    // [0, 0]: the lift takes index 0 of [a,b,c], the handoff takes index 0 of
    // the [b,c] that are left.
    const { backend, music, timer } = build(sequenceRandom([0, 0]))
    backend.setMusicSeconds(120)
    music.start('lift')
    await flush()
    // `PlaylistController.cs:390-391`: the next song starts `CrossFadeTime`
    // early, which is what makes the fade an overlap instead of a gap.
    expect(timer.pendingSeconds()).toBe(120 - MUSIC_CROSSFADE_SECONDS)

    backend.clear()
    timer.run()
    await flush()

    const calls = musicCalls(backend)
    // Both sides of the handoff, same length: that is a crossfade and not two
    // unrelated ramps.
    expect(calls).toContainEqual({
      call: 'musicFadeOut',
      voice: 1,
      src: 'assets/audio/music/a.opus',
      seconds: MUSIC_CROSSFADE_SECONDS,
    })
    expect(calls).toContainEqual({
      call: 'musicFadeIn',
      voice: 2,
      src: 'assets/audio/music/b.opus',
      seconds: MUSIC_CROSSFADE_SECONDS,
    })
    // The leak check. Two voices during the fade is a crossfade; two voices
    // afterwards is two songs at once.
    expect(backend.musicVoices).toHaveLength(1)
  })

  it('advances when a buffer ends without the handoff having run', async () => {
    const { backend, music } = build(sequenceRandom([0, 0]))
    music.start('lift')
    await flush()
    backend.endMusic(1)
    await flush()
    expect(music.playing?.id).toBe('b')
    expect(backend.musicVoices).toHaveLength(1)
  })

  it('stop() cancels the pending handoff, so nothing starts after the mission is over', async () => {
    const { backend, music, timer } = build(sequenceRandom([0, 0.5]))
    music.start('lift')
    await flush()
    music.stop()
    expect(backend.musicVoices).toHaveLength(0)
    expect(timer.pendingSeconds()).toBeNull()
    timer.run()
    await flush()
    expect(backend.musicVoices).toHaveLength(0)
    expect(music.playing).toBeNull()
  })

  it('drops a load that lands after GO has moved on', async () => {
    // The generation guard. A fetch started for the lift can resolve after the
    // player has pressed A, and a late arrival must not become a third voice
    // over the top of the second.
    const { backend, music } = build(sequenceRandom([0, 0.5]))
    music.start('lift')
    music.start('go') // before the first load has resolved
    await flush()
    // 'c': 0.5 of what the lift left, ['b','c'] (DEV-423 carries the pool on).
    expect(backend.musicVoices.map((v) => v.src)).toEqual(['assets/audio/music/c.opus'])
    expect(backend.calls.filter((c) => c.call === 'musicStart')).toHaveLength(1)
  })

  it('does nothing at all with no tracks installed — the state the game ships in', async () => {
    const backend = createRecordingBackend()
    const music = createMusicPlaylist({ backend, warn: () => {} })
    music.start('lift')
    music.start('go')
    music.next()
    music.stop()
    await flush()
    expect(musicCalls(backend)).toEqual([])
    expect(music.playing).toBeNull()
  })
})

// ── 4. volume, `?audio=off`, and a track that will not load ─────────────────

describe('the player can turn it down, and a missing track is silence not a crash', () => {
  it('sends the music gain to its own bus, and mute takes it to zero', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend })
    system.setMusicGain(musicGainFor({ volume: 'full', muted: false }))
    expect(backend.musicGain).toBeCloseTo(MASTER_MUSIC, 12)
    system.setMusicGain(musicGainFor({ volume: 'full', muted: true }))
    expect(backend.musicGain).toBe(0)
    // A step down is the SFX ladder times 2016's playlist master, not a second
    // master of its own.
    system.setMusicGain(musicGainFor({ volume: 'mid', muted: false }))
    expect(backend.musicGain).toBeCloseTo(0.25 * MASTER_MUSIC, 12)
  })

  it('`?audio=off` never fetches and never sounds', async () => {
    const system = createAudioSystem({ backend: createSilentBackend() })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    system.music.setTracks(THREE)
    system.music.start('lift')
    await flush()
    // The silent backend answers `null` without a network round trip: a spec
    // that must not start an audio device has no business pulling megabytes of
    // Opus off R2 either.
    expect(system.running).toBe(false)
    expect(system.music.playing).toBeNull()
    warn.mockRestore()
  })

  it('warns once for a track that 404s and plays the next one', async () => {
    const backend = createRecordingBackend()
    const warnings: string[] = []
    const music = createMusicPlaylist({
      backend,
      random: sequenceRandom([0, 0]),
      scheduler: manualScheduler().scheduler,
      warn: (m) => warnings.push(m),
    })
    music.setTracks(THREE)
    backend.failMusic('assets/audio/music/a.opus')

    music.start('lift')
    await flush()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('a.opus')
    // It did not stop at the bad one.
    expect(backend.musicVoices).toHaveLength(1)
    expect(backend.musicVoices[0]?.src).toBe('assets/audio/music/b.opus')
  })

  it('gives up after one pass when nothing loads, rather than fetching forever', async () => {
    const backend = createRecordingBackend()
    const warnings: string[] = []
    const music = createMusicPlaylist({
      backend,
      random: sequenceRandom([0]),
      scheduler: manualScheduler().scheduler,
      warn: (m) => warnings.push(m),
    })
    music.setTracks(THREE)
    for (const track of THREE) backend.failMusic(track.src)

    expect(() => music.start('lift')).not.toThrow()
    await flush()

    // Three tracks tried, one warning each, then one line saying it has stopped.
    expect(backend.calls.filter((c) => c.call === 'musicLoad')).toHaveLength(3)
    expect(warnings).toHaveLength(4)
    expect(warnings.at(-1)).toContain('no playable tracks')
    expect(music.playing).toBeNull()
    expect(backend.musicVoices).toHaveLength(0)
  })
})

// ── 4b. the two failures that used to look identical (DEV-247) ──────────────
//
// `loadMusic` answers `null` for "no audio device yet" and for "this file is
// broken" alike — one shape, deliberately, so the caller never branches on a
// reason it might get wrong. The PLAYLIST does have to tell them apart, and
// until DEV-247 it did not: a page that asked for music before any gesture
// spent the whole pool and announced that six good files were unplayable.
//
// That is not a hypothetical. It is the line every vrto3d perf run has printed
// since the soundtrack landed, and the reason nobody chased it is that it is
// indistinguishable, in the log, from the REAL bug sitting behind it — the
// deployed site fetching `index.html` for every track.

describe('a missing device and a missing file are not the same failure', () => {
  const buildPlaylist = (warnings: string[]) => {
    const backend = createRecordingBackend()
    const music = createMusicPlaylist({
      backend,
      random: sequenceRandom([0, 0, 0, 0]),
      scheduler: manualScheduler().scheduler,
      warn: (m) => warnings.push(m),
    })
    music.setTracks(THREE)
    return { backend, music }
  }

  it('with no output device it fetches nothing, warns nothing, and blames nobody', async () => {
    const warnings: string[] = []
    const { backend, music } = buildPlaylist(warnings)
    backend.setHasOutput(false)

    music.start('lift')
    await flush()

    // Not one round trip: there is nowhere to decode to, so asking is pure cost.
    expect(backend.calls.filter((c) => c.call === 'musicLoad')).toHaveLength(0)
    expect(warnings).toEqual([])
    expect(music.playing).toBeNull()
    expect(music.playingSeconds).toBeNull()
  })

  it('and the pool survives it: the next gesture gets all three tracks, not none', async () => {
    const warnings: string[] = []
    const { backend, music } = buildPlaylist(warnings)

    // Three events before the device exists — one per track, which is exactly
    // what used to exhaust the pool and latch the playlist silent.
    backend.setHasOutput(false)
    for (let i = 0; i < 3; i += 1) {
      music.start('lift')
      await flush()
    }
    expect(warnings).toEqual([])

    backend.setHasOutput(true)
    music.start('lift')
    await flush()

    expect(backend.musicVoices).toHaveLength(1)
    expect(music.playing).not.toBeNull()
    expect(warnings).toEqual([])
  })

  it('a file that will not load is still a warning, and still gives up after one pass', async () => {
    const warnings: string[] = []
    const { backend, music } = buildPlaylist(warnings)
    for (const track of THREE) backend.failMusic(track.src)

    music.start('lift')
    await flush()

    // The guard above must not have softened this: a device that exists and a
    // file that does not is the case the warning was written for.
    expect(warnings.at(-1)).toContain('no playable tracks')
    expect(music.playingSeconds).toBeNull()
  })
})

// ── 4c. the decoded length (DEV-247) ────────────────────────────────────────
//
// Where the URL is resolved is asserted in `tests/unit/soundtrack-assets.test.ts`
// — it happens in `boot/app.ts`, not here, because `assetUrl()` reads
// `import.meta.env` and this module must stay reachable from a Playwright spec.

describe('what the playlist can prove about a track that arrived', () => {
  it('reports the DECODED length, which is the one thing a broken track cannot fake', async () => {
    const backend = createRecordingBackend()
    backend.setMusicSeconds(137.5)
    const music = createMusicPlaylist({
      backend,
      random: sequenceRandom([0]),
      scheduler: manualScheduler().scheduler,
      warn: () => {},
    })
    music.setTracks(THREE)

    // Selected is not decoded: `playing` is set by the shuffle, synchronously,
    // before a byte has been fetched. That is why an e2e assertion on it would
    // have passed throughout the months the deployed game was silent.
    music.start('lift')
    expect(music.playing).not.toBeNull()
    expect(music.playingSeconds).toBeNull()

    await flush()
    expect(music.playingSeconds).toBe(137.5)

    music.stop(0)
    expect(music.playingSeconds).toBeNull()
  })

  it('DEV-423: a GO cut leaves NO decoded length until the new song has decoded', async () => {
    // The e2e spec reads the GO gap through this field. Before the cut cleared
    // it, the lift track's length went on answering for a song not yet fetched.
    const backend = createRecordingBackend()
    backend.setMusicSeconds(137.5)
    const music = createMusicPlaylist({
      backend,
      random: () => 0,
      scheduler: manualScheduler().scheduler,
      warn: () => {},
    })
    music.setTracks(THREE)
    music.start('lift')
    await flush()
    expect(music.playingSeconds).toBe(137.5)

    backend.setMusicSeconds(201)
    music.start('go')
    expect(music.playingSeconds).toBeNull()
    await flush()
    expect(music.playingSeconds).toBe(201)
  })
})

// ── 5. the wiring: the game already sends both moments ──────────────────────

describe('the two cues come off events `app.ts` already sends', () => {
  const build = () => {
    const backend = createRecordingBackend()
    // A CONSTANT random, not a sequence: `createAudioSystem` hands one source to
    // the cue variation chooser AND to the playlist, so a sequence here would be
    // consumed by whatever `ambient.island` and `ambient.water` draw first and
    // the assertion would be about the order of two unrelated features. Which
    // track gets picked is section 3's question; this section's question is
    // whether the event reaches the playlist at all.
    const system = createAudioSystem({ backend, random: () => 0 })
    system.music.setTracks(THREE)
    return { backend, system }
  }

  it('`mission.begin` starts the lift track', async () => {
    const { backend, system } = build()
    system.event({ type: 'mission.begin' })
    await flush()
    expect(backend.musicVoices.map((v) => v.src)).toEqual(['assets/audio/music/a.opus'])
  })

  it('`launch.start` starts it on the `?mission=` boot, where `mission.begin` never fires', async () => {
    const { backend, system } = build()
    system.event({ type: 'launch.start' })
    await flush()
    expect(backend.musicVoices).toHaveLength(1)
  })

  it('both together still make one voice', async () => {
    const { backend, system } = build()
    system.event({ type: 'mission.begin' })
    system.event({ type: 'launch.start' })
    await flush()
    expect(backend.calls.filter((c) => c.call === 'musicStart')).toHaveLength(1)
  })

  it('`countdown.go` cuts what the lift started and brings a fresh voice up over 1 s', async () => {
    const { backend, system } = build()
    system.event({ type: 'mission.begin' })
    await flush()
    backend.clear()

    system.event({ type: 'countdown.go' })
    await flush()

    const calls = musicCalls(backend)
    expect(calls.some((c) => c.call === 'musicFadeOut' && c.seconds === MUSIC_CUT_SECONDS)).toBe(
      true,
    )
    expect(calls.some((c) => c.call === 'musicStart' && c.voice === 2)).toBe(true)
    expect(calls.some((c) => c.call === 'musicFadeIn' && c.seconds === MUSIC_GO_FADE_SECONDS)).toBe(
      true,
    )
    expect(backend.musicVoices).toHaveLength(1)
    // DEV-423: and it is a DIFFERENT song. This system runs on a constant
    // random of 0, which under 2016's re-seed picked `a` twice — the lift's
    // song, cut and started again, every race.
    expect(backend.musicVoices.map((v) => v.src)).toEqual(['assets/audio/music/b.opus'])
  })

  it('`stopAll` and `dispose` leave no music voice behind', async () => {
    const { backend, system } = build()
    system.event({ type: 'mission.begin' })
    await flush()
    system.stopAll()
    expect(backend.musicVoices).toHaveLength(0)

    system.event({ type: 'mission.begin' })
    await flush()
    system.dispose()
    expect(backend.musicVoices).toHaveLength(0)
  })
})
