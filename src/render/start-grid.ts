// src/render/start-grid.ts — the race start platform, and the pads you launch from.
//
// Matt: *"i'm talking about the race start platform with the ai launch positions
// and whatnot."*
//
// It is a real structure in `int_01_hoverJet.unity` — 21 objects under
// `PlayerStart_ElevatorShaft_Photon`, standing at y ~ 124 with the sea at 116.6
// — and the port drew none of it. You started on a 9 m deck with open water in
// every direction.
//
// ── What is measured and what is authored ─────────────────────────────────
//
// The same bargain as the elevator (DEV-008's shape): the visible 2016 art was
// licence-blocked — the pads are `Converted_Faceted_Meshes`, the ten deck tiles
// are PolyWorld Woodland flooring, the trim is `MM_moulding` — so none of it
// shipped and FF2 drew its own. Rule 7 stopped saying that on 2026-09-23; the
// PADS are 2016's since DEV-444 (below). The tiles and the trim are still FF2's
// slabs, because nobody has ported them yet, not because they cannot ship.
//
// But two pieces are Unity **built-in cubes**, mesh fileID 10202 with no guid,
// and those are exact:
//
//   startingPlatform_collision   three boxes, top face at y = 124.83
//   lightBar                     74.9 x 1 x 4.9 m, at y = 124.80
//
// Three centimetres apart, which is how we know the collider top IS the walking
// surface rather than something under it. So the deck is not an approximation of
// the 2016 platform — it is the volume the 2016 platform occupied.
//
// ── The pads ──────────────────────────────────────────────────────────────
//
//   player   9.35 x 1.67 x 9.29 m    where the elevator arrives
//   ai       10.34 x 1.94 x 10.27    15.5 m off one shoulder
//   ai       10.34 x 1.94 x 10.27    16.6 m off the other
//
// Two AI pads, and `int_01` races exactly two 2016 ghosts. The player pad's size
// is derived from `Projector04-Faceted`'s AABB times its node scale and lands on
// 9.35 x 1.67 x 9.29 — against `spawn.launch.platform.size` of 9.35 x 1.75 x
// 9.28, which was measured from the same mesh down a completely different path.
// Two independent derivations agreeing to 8 cm is the check that says the pads
// are where the ships stood.
//
// ── Why the deck is drawn to its full 22 m ────────────────────────────────
//
// Because the boxes really are that deep and the sea is at 116.6, so 14 m of the
// platform is underwater and 8 m stands proud. Trimming it to a slab would float
// the start line on nothing.
//
// ── The pads are 2016's own art (DEV-444) ─────────────────────────────────
//
// Matt, 2026-09-27: *"give the other planes the same "pad" art we had in the
// 2016 game. (it's the same art we're currently using for the elevator
// platform art)"*. He is right about the mesh, and the scene says so: every
// pad on 2016's start deck is `Projector04-Faceted.asset` (guid 27468cf7…),
// the mesh under `Elevator_animator` that the lift rides on. Rule 7 has let it
// ship from R2 since 2026-09-23, so the octagons below are now only what stands
// until the file lands (or if it never does).
//
//   the AI pads      `Projector04-Faceted 2` / `3`, uniform scale 1.867, in
//                    `Projector04_Mat` on five of the six decks (`int_02`'s
//                    wear `MM_moulding`, vertex colour times white: 7 % lighter
//                    and no specular — not carried, the ledger row says so)
//   the player pad   `Projector04-Faceted (1)`, scale (1.688, 1.606, 1.688), in
//                    `lambert1` — the lift's own material. On `int_01` the lift
//                    arrives 2.7 cm over it at the SAME yaw (-143.7 deg in the
//                    rig): there the two are one dish. Not on every deck; see
//                    `releasePadOf`
//
// The file is `projector04-faceted.glb` (DEV-433's, already on R2): that mesh
// in its OWN frame, Unity z negated and the winding reversed, with
// `Projector04_Mat`'s numbers on its material. A pad is that mesh at the node's
// transform — `pos` is the node ORIGIN, which is the mesh's FOOT (its AABB runs
// 0 .. 1.036 in y), not its centre as the octagon below draws it — and the
// node's scale is `size` over the mesh's own extent. The octagon's centring is
// left as it was: it is the fallback, and `racer-grid.ts`'s `padTop` is written
// against it.
//
// It is a DISH, not a slab: a floor at 0.733 of the height inside a rim at the
// full 1.036. A ship at the release altitude sits IN its dish, over the floor
// and under the rim (video f0055 and f0565), which is why a pad's "top" is the
// floor under the belly and not the top of its box.
//
// ── Where a pad under a ship at the RELEASE goes ──────────────────────────
//
// FF2's own starts — the preset's slots (DEV-125), and 2016's ghost starts on
// the rookie courses (DEV-457) — hold their ships at or just over the player's
// release altitude (a room's people stand on these same starts, DEV-477), and
// the one pad 2016 put under a ship there is the player's: the lift's dish,
// where the ride leaves it.
// So each of those stands on a copy of THAT (`releasePadOf`): the lift's
// height, and 2016's player pad's size and turn. An AI-sized dish at an AI
// pad's height, which is what the octagon stood for, puts its floor 0.21 m
// above the hull on `int_01`: the ship inside its own pad. The grid's own
// player pad is the same pad, off while the lift holds the ship (`setHeld`).
//
// ── The shaft head stops at the rim (DEV-443) ─────────────────────────────
//
// Matt, 2026-09-27: *"let's make sure that the starting platform (where all the
// racers start from) is there - i don't see it anymore."* It was there, drawn
// three slabs and a light bar a frame — and hidden from the seat by 2016's shaft
// head (DEV-438). 2016's segment 08 walls top out at world y 126.48 on
// `int_01` (the port's copy reaches 126.79: it is segment 01's, whose vent sits
// 1.55 m higher than the one `int_01` moved down): 1.65 to 1.96 m over this
// deck's walking surface (124.83) and half a metre under the eye (127.30). From
// the cockpit at the top of the ride it is a wall round the lift, and the deck
// and the nearer pads are behind it.
// The generated shaft it replaced ended at `rimY`, the height the lift's deck
// arrives at (124.24 here), which is what DEV-106 built it to: the mouth is a
// floor. `cutShaftAtRim` holds 2016's shaft to the same line. The ledger row
// has the photographs, and the call that goes with it.

import * as THREE from 'three'
import { JUMPSEAT_MESH_CONE } from '@/game/jumpseat-art'
import { projectorMaterial } from './hover-glow'
import { LAMBERT1_COLOR_SRGB } from './lambert1'

export interface StartGridBox {
  readonly pos: readonly number[]
  readonly quat: readonly number[]
  readonly size: readonly number[]
}

export interface StartGridPad extends StartGridBox {
  readonly role: string
}

export interface StartGridSpec {
  readonly slabs: readonly StartGridBox[]
  readonly lightBar: StartGridBox | null
  readonly pads: readonly StartGridPad[]
}

export interface StartGrid {
  readonly object: THREE.Object3D
  /** The pads, in the order the spec gave them — player first, then the AI. */
  readonly pads: readonly THREE.Object3D[]
  /**
   * DEV-444: stand 2016's pad on every pad, in place of the octagon.
   *
   * `art` is `projector04-faceted.glb`'s scene (`START_PAD_MESH`), as loaded;
   * its geometry and material are copied, so the caller disposes what it
   * loaded. `prepare` sees each new material before anything draws it — the
   * mission's fog, as the grid's own materials get it. The octagons are
   * HIDDEN, never removed. Throws on a file that is not that mesh.
   */
  dress(art: THREE.Object3D, prepare?: (material: THREE.Material) => void): void
  /**
   * While the lift holds the ship its own dish IS the player's pad, and the
   * grid's copy stands where that dish stands — to 8 mm where 2016 put them
   * together — so the copy is off until the lift lets go and hides its
   * platform (`render/elevator.ts`'s `setReleased`), and then it is the pad the
   * player left. The mirror of that call, and written every frame beside it.
   */
  setHeld(held: boolean): void
  /**
   * DEV-553 (DEV-461's `?arrival=rise`, the behaviour since): draw every pad
   * but the player's `drop` metres under where it stands, so the others' lifts
   * are seen arriving with the player's. 0 puts them back. Written every frame
   * by the caller, like `setHeld`.
   */
  arrive(drop: number): void
  /**
   * DEV-550: a hover glow under every pad `under[i]` marks as floating — the
   * anti-grav disc 2016 puts in every upturned `Projector04` (the HoverJet's
   * wings, the JumpSeat's engines), in register under an upright one
   * (`HOVER_GLOW_REGISTER`). A child of its pad, so it rises with `arrive` and
   * hides with `setHeld`. One plain mesh a pad in the caller's `material`
   * (`render/hover-glow.ts`'s `glowMaterial`, prepared by the caller): no
   * instancing, because `USE_INSTANCING` is a define and so a program of its
   * own. The grid owns `material` from here. Once; a second call does nothing.
   */
  hover(under: readonly boolean[], material: THREE.Material): void
  /**
   * DEV-549: stand 2016's deck (`render/start-deck.ts`) in place of the slabs,
   * which hide — 2016's colliders, whose renderers were off. The grid owns it
   * from here. The light bar stays: 2016 drew it.
   */
  standDeck(deck: { readonly object: THREE.Object3D; dispose(): void }): void
  /** The hover glows `hover` stood, in pad order (null under a pad that does not float). */
  readonly glows: readonly (THREE.Mesh | null)[]
  dispose(): void
}

/**
 * DEV-550: the JumpSeat's hover engine, read off the sheet (`JUMPSEAT.art.
 * engines[0]`, 2016's prefab): `Sphere (1)`, scale (1.153, 0.351, 1.153), sits
 * 0.276 m from its upturned `Projector04` (scale 0.306 x 0.436, so 1.695 m
 * across and 0.454 m deep). So the disc is 0.680 of its dish's width across and
 * 0.775 of its dish's depth thick. In the engine it sits in the bowl of the
 * upturned dish, seen from below; under an UPRIGHT pad it hangs from the foot,
 * its top on the foot, so that it shows from beside the pad — from the seat, at
 * the pads' own height — and not only from under it. Tucked half into the skirt
 * (the first try) the skirt hid all but a hairline of it from every view a
 * player has (`dev550/after/rookie_01_hoverJet-docked-outside-low-…png`).
 */
export const HOVER_GLOW_REGISTER = Object.freeze({ across: 0.68, thick: 0.775 })

/** A hover glow's mesh, by name. */
export const START_PAD_GLOW = 'start-pad-glow'

/** 2016's pad: `Projector04-Faceted`, in its own frame — DEV-433's file, on R2. */
export const START_PAD_MESH: string = JUMPSEAT_MESH_CONE

/** A dressed pad's mesh, by name: the one `tests/e2e/race-start.spec.ts` reads. */
export const START_PAD_ART = 'start-pad-2016'

/**
 * The faceted look, the same way `render/elevator.ts` gets it.
 *
 * `flatShading` is the whole art style: one normal per face, hard creases, no
 * smoothing.
 */
const faceted = (
  color: number,
  roughness: number,
  emissive = 0x000000,
  emissiveIntensity = 0,
): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness: 0,
    flatShading: true,
    emissive,
    emissiveIntensity,
  })

const place = (o: THREE.Object3D, b: StartGridBox): void => {
  o.position.set(b.pos[0] as number, b.pos[1] as number, b.pos[2] as number)
  o.quaternion.set(
    b.quat[0] as number,
    b.quat[1] as number,
    b.quat[2] as number,
    b.quat[3] as number,
  )
}

export const createStartGrid = (spec: StartGridSpec): StartGrid => {
  const object = new THREE.Group()
  object.name = 'start-grid'
  const owned: { dispose(): void }[] = []
  const keep = <T extends THREE.BufferGeometry | THREE.Material>(x: T): T => {
    owned.push(x)
    return x
  }

  // ── the deck ───────────────────────────────────────────────────────────
  //
  // One material for all three slabs: they are one structure and shading them
  // apart would draw a seam the 2016 platform does not have.
  const slabMaterial = keep(faceted(0x8a8792, 0.85))
  for (const slab of spec.slabs) {
    const geometry = keep(
      new THREE.BoxGeometry(slab.size[0] as number, slab.size[1] as number, slab.size[2] as number),
    )
    const mesh = new THREE.Mesh(geometry, slabMaterial)
    mesh.name = 'start-slab'
    place(mesh, slab)
    object.add(mesh)
  }

  // ── the start line ─────────────────────────────────────────────────────
  //
  // Emissive, because a 75 m bar of unlit grey across the deck reads as a kerb
  // rather than as a line. `lightBar` is its 2016 name and a light is what it is.
  if (spec.lightBar) {
    const bar = spec.lightBar
    const geometry = keep(
      new THREE.BoxGeometry(bar.size[0] as number, bar.size[1] as number, bar.size[2] as number),
    )
    const mesh = new THREE.Mesh(geometry, keep(faceted(0x9fe8ff, 0.4, 0x3fd0ff, 1.4)))
    mesh.name = 'start-lightbar'
    place(mesh, bar)
    object.add(mesh)
  }

  // ── the pads ───────────────────────────────────────────────────────────
  //
  // Octagonal rather than square: FF2's own design, and the one shape that reads
  // as a landing pad at a glance without pretending to be the mesh it replaces.
  // A `CylinderGeometry` with 8 radial segments IS an octagonal prism.
  const pads: THREE.Object3D[] = []
  // Lighter than the deck on purpose: a pad that shades the same as the slab
  // under it reads as a painted marking rather than as something you stand on.
  const padDeck = keep(faceted(0xc9c6cf, 0.6))
  const padRim = keep(faceted(0x3fd0ff, 0.5, 0x2aa8d8, 0.9))
  for (const pad of spec.pads) {
    const group = new THREE.Group()
    group.name = `start-pad-${pad.role}`
    const w = pad.size[0] as number
    const h = pad.size[1] as number
    const d = pad.size[2] as number
    const body = new THREE.Mesh(
      keep(new THREE.CylinderGeometry(0.5, 0.44, 1, 8, 1)),
      pad.role === 'player' ? padDeck : padDeck,
    )
    // Scaled rather than built at size, so the eight-sided prism stretches to a
    // pad that is not quite square — which these are not.
    body.scale.set(w, h, d)
    group.add(body)
    // A rim just proud of the deck, so the pad reads from above as well as side-on.
    const rim = new THREE.Mesh(keep(new THREE.TorusGeometry(0.46, 0.035, 3, 8)), padRim)
    rim.rotation.x = Math.PI / 2
    rim.scale.set(w, d, h)
    rim.position.y = h * 0.5
    group.add(rim)
    place(group, pad)
    object.add(group)
    pads.push(group)
  }

  let dressed = false
  const glows: (THREE.Mesh | null)[] = spec.pads.map(() => null)
  return {
    object,
    pads,
    glows,
    dress(art, prepare) {
      if (dressed) return
      dressed = true
      art.updateMatrixWorld(true)
      let found: THREE.Mesh | null = null
      art.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (!found && mesh.isMesh) found = mesh
      })
      const source = found as THREE.Mesh | null
      if (!source) throw new Error('start-grid: the pad file holds no mesh')
      // In the file's own frame: its node transform baked in, as
      // `game/jumpseat-art.ts` takes the same file.
      const geometry = keep(source.geometry.clone().applyMatrix4(source.matrixWorld))
      geometry.computeBoundingBox()
      const extent = (geometry.boundingBox as THREE.Box3).getSize(new THREE.Vector3())
      if (!(extent.x > 0 && extent.y > 0 && extent.z > 0))
        throw new Error('start-grid: the pad mesh has no extent')
      // `Projector04_Mat`, off the file's own record: the wing's projectors and
      // the JumpSeat's cones wear the same one (`projectorMaterial`).
      const arrived = source.material as THREE.Material
      const others = keep(projectorMaterial(arrived))
      // The player's pad is `lambert1`, the lift's material: the same shader
      // and the same record but for `_Color`, so the same program.
      const player = keep(projectorMaterial(arrived))
      player.color.setRGB(
        LAMBERT1_COLOR_SRGB[0],
        LAMBERT1_COLOR_SRGB[1],
        LAMBERT1_COLOR_SRGB[2],
        THREE.SRGBColorSpace,
      )
      player.name = 'lambert1'
      prepare?.(others)
      prepare?.(player)
      spec.pads.forEach((pad, i) => {
        const group = pads[i] as THREE.Object3D
        for (const child of group.children) child.visible = false
        const mesh = new THREE.Mesh(geometry, pad.role === 'player' ? player : others)
        mesh.name = START_PAD_ART
        // The node's scale is `size` over the mesh's own extent: `size` is the
        // extractor's `m_LocalAABB` times that scale (`tools/extract/level.mjs`,
        // `startGridSpec`, which rounds the AABB to 5.54 x 1.04 x 5.50 — 0.4 %
        // tall, 8 mm on an AI pad). At the node's origin: the mesh's foot.
        mesh.scale.set(
          (pad.size[0] as number) / extent.x,
          (pad.size[1] as number) / extent.y,
          (pad.size[2] as number) / extent.z,
        )
        group.add(mesh)
      })
    },
    setHeld(held) {
      spec.pads.forEach((pad, i) => {
        if (pad.role === 'player') (pads[i] as THREE.Object3D).visible = !held
      })
    },
    arrive(drop) {
      spec.pads.forEach((pad, i) => {
        if (pad.role !== 'player')
          (pads[i] as THREE.Object3D).position.y = (pad.pos[1] as number) - drop
      })
    },
    standDeck(deck) {
      object.add(deck.object)
      for (const child of object.children) if (child.name === 'start-slab') child.visible = false
      owned.push(deck)
    },
    hover(under, material) {
      if (glows.some((g) => g !== null)) return
      owned.push(material)
      const disc = keep(new THREE.SphereGeometry(0.5, 16, 8))
      spec.pads.forEach((pad, i) => {
        if (!under[i]) return
        const group = pads[i] as THREE.Object3D
        // Centred under what the pad DRAWS: the dish's footprint stands 0.2 m
        // off its node's origin.
        const art = group.getObjectByName(START_PAD_ART) as THREE.Mesh | undefined
        const centre = new THREE.Vector3()
        if (art) {
          art.geometry.computeBoundingBox()
          ;(art.geometry.boundingBox as THREE.Box3).getCenter(centre).multiply(art.scale)
        }
        const mesh = new THREE.Mesh(disc, material)
        mesh.name = START_PAD_GLOW
        const thick = (pad.size[1] as number) * HOVER_GLOW_REGISTER.thick
        mesh.position.set(centre.x, -thick / 2, centre.z)
        mesh.scale.set(
          (pad.size[0] as number) * HOVER_GLOW_REGISTER.across,
          (pad.size[1] as number) * HOVER_GLOW_REGISTER.thick,
          (pad.size[2] as number) * HOVER_GLOW_REGISTER.across,
        )
        group.add(mesh)
        glows[i] = mesh
      })
    },
    dispose() {
      for (const x of owned) x.dispose()
    },
  }
}

/**
 * The pad under a ship at the RELEASE: where the lift leaves the player.
 *
 * Since DEV-548 it IS the lift's dish, docked: the dish's pose in the seat's
 * frame (`launch.dish`, read per mission off `Elevator_animator/
 * Projector04-Faceted` by `tools/extract/level.mjs`), carried to the top of the
 * ride — the spawn pose, then the rise straight up — and its size. The lift's
 * dish hands over to this pad the moment it docks (`boot/app.ts`), so the two
 * must be one dish: they are, to the 8 mm the extractor's rounded AABB allows
 * (`start-grid-art.test.ts`, against the dish the menu scene's own pipeline
 * builds).
 *
 * Until DEV-548 its place and turn were 2016's player pad's,
 * `Projector04-Faceted (1)`, and 2016 authored that one three ways: the lift's
 * dish to 2.7 cm on `int_01` and `hoverJet_kauai_beg`, 0.41 m over it on
 * `adv_01`, and 0.65 m over and 1.6 m across on `adv_02` (and `int_02`'s `2
 * (1)`, an AI pad's size, 1.6 m across). Matt, 2026-09-30, on moving those:
 * *"you can edit those if absolutely needed"* — and a hand-over at the dock
 * needs it, or the car jumps 1.6 m forward under the waiting ship.
 *
 * Its height is the lift's `rimY` over the spawn (`render/elevator.ts`): the
 * dish's foot, 2.2 m under the seat. FF2's own starts — the preset's slots
 * (DEV-125) and the rookie courses' ghost starts (DEV-457) — are held at that
 * same altitude, so each stands on a copy of this, moved across the deck
 * (`padsUnder`). A launch extracted before DEV-548 (no `dish`) falls back to the
 * old rule: `(1)`'s place and turn, the platform's height and size. Null with
 * no lift.
 */
export const releasePadOf = (
  grid: Pick<StartGridSpec, 'pads'>,
  spawn: { readonly pos: readonly number[]; readonly quat: readonly number[] },
  launch?: {
    readonly rise: number
    readonly platform?: {
      readonly offset: readonly number[]
      readonly shipOffset: readonly number[]
      readonly size: readonly number[]
    } | null
    readonly dish?: LiftDish | null
  } | null,
): StartGridPad | null => {
  const platform = launch?.platform
  if (!launch || !platform) return null
  const dish = launch.dish
  if (dish) {
    // The rise is along the SEAT's up, not the world's: 2016 animates the
    // animator's local y, in a rig that is not quite level everywhere —
    // `int_02`'s leans 0.1 degrees, which over a 106.6 m ride is 0.19 m
    // across, and the drawn lift (`render/elevator.ts`, in the anchor's frame)
    // rises the same way.
    const turn = new THREE.Quaternion().fromArray(spawn.quat as number[])
    const at = new THREE.Vector3()
      .fromArray(dish.pos as number[])
      .add(new THREE.Vector3(0, launch.rise, 0))
      .applyQuaternion(turn)
      .add(new THREE.Vector3().fromArray(spawn.pos as number[]))
    const quat = turn.multiply(new THREE.Quaternion().fromArray(dish.quat as number[]))
    return {
      role: 'player',
      pos: [at.x, at.y, at.z],
      quat: [quat.x, quat.y, quat.z, quat.w],
      size: dish.size,
    }
  }
  const foot =
    (spawn.pos[1] as number) +
    launch.rise +
    (platform.offset[1] as number) -
    (platform.shipOffset[1] as number)
  const player = grid.pads.find((p) => p.role === 'player')
  const liftSized =
    player !== undefined &&
    Math.abs((player.size[0] as number) - (platform.size[0] as number)) < LIFT_SIZE_MATCH
  return {
    role: 'player',
    pos: [(player ?? spawn).pos[0] as number, foot, (player ?? spawn).pos[2] as number],
    quat: (player ?? spawn).quat,
    size: liftSized ? player.size : platform.size,
  }
}

/** The lift's own dish in the seat's frame, three space (`launch.dish`, DEV-548). */
export interface LiftDish {
  readonly pos: readonly number[]
  readonly quat: readonly number[]
  readonly size: readonly number[]
}

/**
 * Metres across within which an authored player pad is the lift's own dish:
 * `(1)` is 9.35 m on every deck, the lift 9.35 m, an AI pad 10.34 m. The
 * pre-DEV-548 fallback's test.
 */
const LIFT_SIZE_MATCH = 0.1

/**
 * A pad under each of `starts`: `template` moved across the deck to the start's
 * x and z, keeping its height, its size and its turn — so every ship held at the
 * release altitude sits in its dish as the player sits in the player's.
 */
export const padsUnder = (
  template: StartGridPad,
  starts: readonly { readonly pos: readonly number[] }[],
  role: string,
): StartGridPad[] =>
  starts.map((s) => ({
    role,
    pos: [s.pos[0] as number, template.pos[1] as number, s.pos[2] as number],
    quat: template.quat,
    size: template.size,
  }))

/**
 * Does this racer start hold its ship at the player's release altitude, and so
 * stand on a copy of the player's pad? The preset's slots (DEV-125) and, on a
 * course with no `ai` pad, 2016's two ghost starts (DEV-442; on both presets
 * since DEV-457). 2016's `ai` pads carry their own dish (`pad`), and the
 * player's start (`player`, a room's start 0, DEV-477) is the lift's.
 */
export const heldAtRelease = (start: { readonly from: { readonly kind: string } }): boolean =>
  start.from.kind === 'slot' || start.from.kind === 'ghost'

/** The deck of a course that authored none (the two rookie courses): pads only. */
export const NO_DECK: StartGridSpec = Object.freeze({ slabs: [], lightBar: null, pads: [] })

/**
 * Every pad the deck draws: 2016's own, the player's replaced by the pad under
 * it at the release, then one under each start held at the release (`slots`,
 * `heldAtRelease`) — in single player every one of them, in a room those the
 * race put a ship on (DEV-477: a person there stands on the pad a racer would
 * have, and never on a second one).
 *
 * DEV-548: where the deck authored no player pad — the two rookie courses,
 * which authored no deck — the pad under the release leads the list all the
 * same. Since the lift's dish hands over at the DOCK, not the release, that
 * copy is what the player stands on through the countdown; without it the
 * dish hid at the dock and the ship hung over the shaft head on nothing.
 */
export const deckPadsOf = (
  grid: Pick<StartGridSpec, 'pads'>,
  release: StartGridPad | null,
  slots: readonly { readonly pos: readonly number[] }[],
): StartGridPad[] => [
  ...(release && !grid.pads.some((p) => p.role === 'player') ? [release] : []),
  ...grid.pads.map((p) =>
    p.role === 'player' && release ? release : release ? liftSized(p, release) : p,
  ),
  ...(release ? padsUnder(release, slots, 'ai') : []),
]

/**
 * DEV-547: one of 2016's own pads at the LIFT's size, where it stands and as it
 * is turned. Matt, 2026-09-30, on DEV-461's call to shrink 2016's two AI pads
 * to the lift's: *"ok"*. In his fiction every pad is a lift's car and every
 * racer rode the same lift, so every pad is one size: 2016 authored its AI pads
 * at uniform scale 1.867 (10.34 m across, 1.94 m tall), 10 % over the lift's
 * 1.688 x 1.606 x 1.688 (9.35 x 1.67). Shrunk about its node's origin — the
 * dish's foot, which stays on the deck where 2016 stood it — so the floor drops
 * by its share of the lost height. The racers do not move: the sim's starts are
 * 2016's (`game/racer-grid.ts`), and each stands that much higher over its
 * floor. A deck with no lift (the JumpSeat's) keeps 2016's sizes: there is no
 * lift to size from.
 */
export const liftSized = (pad: StartGridPad, release: StartGridPad): StartGridPad => ({
  ...pad,
  size: release.size,
})

// ── The shaft head, held to the rim (DEV-443) ────────────────────────────────

/**
 * `source` cut to the half-space `y <= top`: every triangle wholly under the
 * line kept as it is, every one wholly over it dropped, and every one crossing
 * it clipped (Sutherland-Hodgman against the one plane) and fanned back into
 * triangles in the same winding. Every attribute is interpolated along the cut
 * edges — a baked vertex colour included — and the new corners sit on `top`
 * exactly. Returns `source` itself when nothing stands over the line.
 */
export const trimAbove = (source: THREE.BufferGeometry, top: number): THREE.BufferGeometry => {
  const flat = source.index ? source.toNonIndexed() : source
  const position = flat.getAttribute('position')
  let over = false
  for (let i = 0; i < position.count && !over; i++) over = position.getY(i) > top
  if (!over) return source
  const names = Object.keys(flat.attributes)
  const attributes = names.map((name) => flat.getAttribute(name))
  const out = names.map(() => [] as number[])
  const corner = (i: number): number[][] =>
    attributes.map((a) => {
      const v: number[] = []
      for (let k = 0; k < a.itemSize; k++) v.push(a.getComponent(i, k))
      return v
    })
  const between = (a: number[][], b: number[][], s: number): number[][] =>
    a.map((va, n) => va.map((x, k) => x + (((b[n] as number[])[k] as number) - x) * s))
  const emit = (v: number[][]): void => {
    v.forEach((values, n) => {
      ;(out[n] as number[]).push(...values)
    })
  }
  const yAt = names.indexOf('position')
  for (let t = 0; t + 2 < position.count; t += 3) {
    const ids = [t, t + 1, t + 2]
    const ys = ids.map((i) => position.getY(i))
    const under = ys.map((y) => y <= top)
    if (under.every(Boolean)) {
      for (const i of ids) emit(corner(i))
      continue
    }
    if (!under.some(Boolean)) continue
    const kept: number[][][] = []
    for (let k = 0; k < 3; k++) {
      const a = ids[k] as number
      const b = ids[(k + 1) % 3] as number
      const ya = ys[k] as number
      const yb = ys[(k + 1) % 3] as number
      if (under[k]) kept.push(corner(a))
      if (under[k] !== under[(k + 1) % 3]) {
        const cut = between(corner(a), corner(b), (top - ya) / (yb - ya))
        ;(cut[yAt] as number[])[1] = top
        kept.push(cut)
      }
    }
    for (let k = 1; k + 1 < kept.length; k++) {
      emit(kept[0] as number[][])
      emit(kept[k] as number[][])
      emit(kept[k + 1] as number[][])
    }
  }
  const trimmed = new THREE.BufferGeometry()
  names.forEach((name, n) => {
    const a = attributes[n] as THREE.BufferAttribute
    trimmed.setAttribute(
      name,
      new THREE.Float32BufferAttribute(out[n] as number[], a.itemSize, a.normalized),
    )
  })
  trimmed.computeBoundingBox()
  trimmed.computeBoundingSphere()
  if (flat !== source) flat.dispose()
  return trimmed
}

/**
 * A lift that takes 2016's shaft cut at its own `rimY` — the height its deck
 * arrives at, where the generated shaft always ended (DEV-106) — and otherwise
 * dresses exactly as `lift` does. The shaft arrives in the lift's own frame,
 * the frame `rimY` is written in (`render/elevator.ts`'s `dress`), so the cut
 * is one number. Nothing else of the art is touched: the deck rides as it did.
 */
export const cutShaftAtRim = <A extends { readonly shaft: THREE.Object3D }>(lift: {
  readonly rimY: number
  dress(art: A): void
}): { dress(art: A): void } => ({
  dress(art) {
    const mesh = art.shaft as THREE.Mesh
    if (mesh.isMesh) {
      const before = mesh.geometry
      mesh.geometry = trimAbove(before, lift.rimY)
      if (mesh.geometry !== before) before.dispose()
    }
    lift.dress(art)
  },
})
