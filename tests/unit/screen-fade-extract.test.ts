// tests/unit/screen-fade-extract.test.ts — 2016 fades every scene change, and
// the two numbers it fades by are not the two numbers anybody would have typed.
//
// ── What this file is guarding ────────────────────────────────────────────
//
// `docs/plan/LOADING.md` §2 was written from a grep, and the grep gave three
// wrong answers. All three are the same class of error and all three are caught
// by the liveness walk plus "which prefab does a shipped scene actually name":
//
//   1. `setGameplayOptions.unity` has THIRTY `Fade_Mesh` objects at 1.5 s,
//      every one tagged `fader`, every one with `m_Enabled: 1` and
//      `m_IsActive: 1` on its own GameObject — and NOT ONE OF THEM RUNS. They
//      hang under a `Cameras (1)` and an `old` that are both `m_IsActive: 0`.
//      This is DEV-074's PlayerBoundary bug in a different component.
//
//   2. The menus fade at 0.75 s, off
//      `Prefabs/legacy_root_prefabs/PreFabs/Cameras.prefab` — which is the one
//      the shipped menu scenes instantiate. `Prefabs/Cameras.prefab` says 1.5
//      and NOTHING SHIPPED INSTANTIATES IT. Same basename, one directory
//      apart, different number: the `islandgroup_height.png` trap wearing a
//      camera rig.
//
//   3. Four missions carry a disconnected copy of `Init Level.prefab`'s 1.5 s
//      fader beside the rig's 1.0 s one. If both were live, 2016's own
//      duration in those four would be undefined — `FindGameObjectWithTag`
//      does not promise an order. They are not live, and §4 below is the loud
//      counterpart that will say so if that ever changes.
//
// ── Assert the relationship, not the value (trap 24) ──────────────────────
//
// The literals below are deliberately few. What is asserted is mostly
// structural: that the menu number is the rig the menu scenes NAME rather than
// the decoy, that the mission rig is live in thirteen of thirteen, that the
// count of live faders in a scene is one. Those are true independently of what
// anybody believed the number was.

import { describe, expect, it } from 'vitest'
import { FADE, PROVENANCE, STRUCTURAL } from '@/generated/constants.generated'

const SF = STRUCTURAL.screenFade
const MISSION_COUNT = 13

/** `PROVENANCE` is a plain record and the key may be absent; a missing key is a failure, not a skip. */
const prov = (key: string) => {
  const entry = PROVENANCE[key]
  if (!entry) throw new Error(`${key} is not in the constants sheet`)
  return entry
}

describe('1. the sheet carries the fade, with its provenance', () => {
  it('has both durations, traced to a shipped prefab', () => {
    for (const key of ['fade.missionSeconds', 'fade.menuSeconds'] as const) {
      const p = prov(key)
      expect(p.trust).toBe('verified')
      expect(p.origin).toBe('shipped-prefab')
      expect(p.unit).toBe('s')
      expect(typeof p.value).toBe('number')
    }
  })

  it('names the prefab and the fileID each number came out of', () => {
    expect(prov('fade.missionSeconds').source).toContain(FADE.missionRigPrefab)
    expect(prov('fade.missionSeconds').fileId).not.toBeNull()
    expect(prov('fade.menuSeconds').source).toContain(FADE.menuRigPrefab)
  })

  it('takes the 0.85 clamp from the method body, not from a serialised field', () => {
    // `if (fadeValue > 0.85) fadeValue = 1` is an inline literal, so no prefab
    // can move it — which is why this one is `verified` and not `code-default`.
    const p = prov('fade.solidAtFraction')
    expect(p.origin).toBe('csharp-initializer')
    expect(p.trust).toBe('verified')
    expect(p.source).toContain('Fade_Mesh.cs')
    expect(p.line).not.toBeNull()
    // The visible ramp finishes EARLY. A port that runs the full duration is
    // 15% slower to black than 2016 was.
    expect(FADE.solidAtFraction).toBeGreaterThan(0)
    expect(FADE.solidAtFraction).toBeLessThan(1)
  })

  it('checked the curve rather than assuming it was linear', () => {
    expect(SF.curveIsLinear).toBe(true)
    expect(FADE.curve).toBe('linear')
  })
})

describe('2. the mission fade is the rig every shipped mission instantiates', () => {
  it('is live in all thirteen', () => {
    expect(SF.missionsWithLiveRig).toHaveLength(MISSION_COUNT)
  })

  it('is not overridden by any of them — no scene moved fadeTime', () => {
    // Hard rule 2's last step. A `fadeTime=` in a scene's m_Modifications would
    // mean the fade is per-mission and does not belong in the sheet at all;
    // the extractor warns on exactly that, and this is the assertion form.
    const overrides = SF.census
      .flatMap((row) => ('fadeOverridesInScene' in row ? row.fadeOverridesInScene : []))
      .filter((o: string) => o.startsWith('fadeTime='))
    expect(overrides).toEqual([])
  })

  it('counts the STRIPPED instances too, or eight missions look like they have no fade', () => {
    // Five of the thirteen carry a materialised `!u!114` Fade_Mesh; the other
    // eight carry only a `!u!1001` instance of the rig, whose components live
    // in the .prefab file. A name grep over the scenes finds nothing in those
    // eight — CLAUDE.md's stripped-prefab trap, which hid the finish gate for
    // the life of the port.
    const byInstance = SF.census.filter((r) => r.how.startsWith('prefab instance'))
    const materialised = SF.census.filter((r) => r.how === 'materialised')
    expect(byInstance.length).toBeGreaterThanOrEqual(MISSION_COUNT)
    expect(materialised.length).toBeLessThan(MISSION_COUNT)
  })
})

describe('3. the menu fade is the rig the MENU SCENES name, not its namesake', () => {
  it('comes off the legacy rig, which is the one they instantiate', () => {
    expect(FADE.menuRigPrefab).toContain('legacy_root_prefabs')
    expect(SF.menuScenes.length).toBeGreaterThanOrEqual(6)
  })

  it('differs from the decoy prefab of the same basename', () => {
    // The point is the DISAGREEMENT: if these two ever coincide this test stops
    // proving anything, and someone should find a second distinguishing fact.
    expect(SF.decoyMenuRig).not.toEqual([])
    for (const t of SF.decoyMenuRig) expect(t).not.toBe(FADE.menuSeconds)
  })

  it('does not depend on which camera rig CameraMode turns on', () => {
    // Both candidates sit under a rig root with `m_IsActive: 0` that
    // `CameraMode.cs:45-46` SetActive()s at runtime. Treating dormant as dead
    // reports the menus as having no fader; treating it as live would be a
    // guess — except that both candidates carry the same number, which is what
    // makes the guess unnecessary. That is the fact under test.
    expect(SF.menuRigCandidates.length).toBeGreaterThanOrEqual(2)
    for (const c of SF.menuRigCandidates) expect(c).toContain(`fadeTime=${FADE.menuSeconds}`)
  })

  it('is not overridden by any menu scene', () => {
    expect(SF.menuScenes.flatMap((m) => m.overrides)).toEqual([])
  })
})

describe('4. the DEATH fade, which is a different shape and different numbers', () => {
  it('takes both numbers out of the method body, anchored', () => {
    // `Trigger_Kill.cs` carries two `WaitForSeconds` — 0.3 in `DelayedStart`
    // and 2.5 in `DelayedReload` — so the extractor anchors each regex on a
    // unique neighbouring statement. A grep for the call alone would have been
    // wrong by 2.4 seconds and right-looking.
    for (const key of ['fade.killSeconds', 'fade.respawnHoldSeconds'] as const) {
      const p = prov(key)
      expect(p.trust).toBe('verified')
      expect(p.origin).toBe('csharp-initializer')
      expect(p.unit).toBe('s')
      expect(p.source).toContain('Trigger_Kill.cs')
      expect(p.line, `${key} has a line in the source`).toBeGreaterThan(0)
    }
  })

  it('is a SNAP, not a fade — an order of magnitude shorter than every other one', () => {
    // The claim, as a relationship rather than as 0.1: a death does not look
    // like a transition. If these two ever come close, something has flattened
    // the one moment in the game that is supposed to be abrupt.
    expect(FADE.killSeconds).toBeLessThan(FADE.missionSeconds / 5)
    expect(FADE.killSeconds).toBeLessThan(FADE.menuSeconds / 5)
  })

  it('finishes going black long before the hold is over', () => {
    // THE guard for the respawn. The sim holds `fade.respawnHoldSeconds` as its
    // `dying` phase and moves the ship at the end of it; if the snap had not
    // finished by then the ship would teleport in plain view, which is the
    // whole thing the curtain exists to hide. `solidAtFraction` is in it
    // because the visible ramp lands early — 2016's own clamp.
    const solidAt = FADE.killSeconds * FADE.solidAtFraction
    expect(solidAt).toBeLessThan(FADE.respawnHoldSeconds / 10)
  })

  it('names the chain, so the respawn is checkable against a source and not a memory', () => {
    const chain = SF.deathChain
    expect(chain.killFadeLine).toContain('Trigger_Kill.cs:')
    expect(chain.holdLine).toContain('Trigger_Kill.cs:')
    // The way BACK in, and the reason there is no separate `respawnInSeconds`
    // key: 2016's reloaded scene fades in on its own fresh fader, which is at
    // `missionSeconds` again. If this line ever goes missing the claim has lost
    // its source and the extractor warns.
    expect(chain.fadeInCaller).toContain('LoadLevelArt.cs:')
  })

  it('records the stray 0.3 that looks like a third duration and is not', () => {
    // `Ship_HoverShip.Flash()` sets `meshFader.fadeTime = 0.3f` on a collision
    // and never puts it back. It governs nothing — the scene's fade-in has
    // already happened and `RestartLevel` overrides it again on the way out —
    // but it is the kind of line that gets found later and ported as a feature.
    expect(SF.deathChain.strayMutation).toBeGreaterThan(0)
  })
})

describe('5. the liveness walk, and the loud counterpart', () => {
  it('finds no scene where two live faders disagree', () => {
    // Empty is the good case. A row appearing here means 2016's own duration in
    // that scene is undefined behaviour and the sheet's number is a choice.
    expect(SF.ambiguousScenes).toEqual([])
  })

  it('records the four Init Level copies as DEAD, and will say so if one wakes', () => {
    // The guard that has to be loud: these four are the only reason `1.5` was
    // ever a candidate for the mission fade. If the walk ever calls one live,
    // this fails rather than quietly re-opening the question.
    expect(SF.initLevelCopies).toHaveLength(4)
    for (const row of SF.initLevelCopies) {
      expect(row).toContain('fadeTime=1.5')
      expect(row).toContain('live=false')
    }
  })

  it('finds thirty dead faders in setGameplayOptions, and zero live ones', () => {
    // The whole reason this file exists. Reading `m_Enabled` and the fader's own
    // `m_IsActive` says thirty live faders at 1.5 s; the full `m_Father` walk
    // says none. A change that makes this number non-zero has either fixed a
    // liveness bug or introduced one, and either way a human should look.
    const levelSelect = SF.menuScenes.find((m) => m.scene.includes('setGameplayOptions'))
    expect(levelSelect).toBeDefined()
    expect(levelSelect?.materialised).toHaveLength(30)
    expect(levelSelect?.materialised.filter((f) => f.live)).toEqual([])
    for (const f of levelSelect?.materialised ?? []) {
      expect(f.fadeTime).toBe(1.5)
      expect(f.deadAncestors.length).toBeGreaterThan(0)
    }
  })
})
