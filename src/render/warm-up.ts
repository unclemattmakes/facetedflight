// src/render/warm-up.ts — pay for the world's first draw under the curtain.
//
// ── The hitch this removes (DEV-117) ─────────────────────────────────────
//
// Matt, 2026-09-16: *"big hitch near end of elevator ride (when level is
// un-hidden?)"*. Measured on `int_01_hoverJet`, the reveal frame — the one
// where `trigger_enableTerrain` switches the land on at rise 100.4 — took
// **2,067 and 2,567 ms** on two rides, against a ride p95 of 16.8 ms. In that
// one frame three compiled **19 GLSL programs** (17 `physical` — the terrain
// material and every prop material under the land group — and the two
// shadow-depth variants, plain and instanced) and uploaded **164 geometries**.
// Nothing else changed: no GC, no texture, no chunk burst.
//
// The cause is structural rather than a bug: three compiles a program and
// uploads a geometry on the first frame that DRAWS it, and the land group is
// `visible = false` from world build until the lift breaks the surface
// (`boot/app.ts`, the `trigger_enableTerrain` block). So the first draw of the
// entire island lands on a live frame, 100 m up a shaft, with the player
// looking at it.
//
// ── Why `renderer.compile()` alone was not the fix ────────────────────────
//
// Tried first, and it left the hitch at 2.85 s. `WebGLRenderer.compile` keys
// the program on the CURRENT render target: with none bound it builds the
// canvas variant — `outputColorSpace` sRGB, the renderer's tone mapping — while
// the flat Anniversary frame is drawn by the bloom composer INTO a linear
// render target (DEV-091), which is a different variant of every program
// (`srgb-linear`, `NoToneMapping`). 34 programs were compiled and not one of
// them was used. And `compile` never touches the shadow-depth materials or
// the vertex buffers, which are the other two thirds of the stall.
//
// ── What this does instead ────────────────────────────────────────────────
//
// One real draw, under the curtain. At the end of the world build — before
// `loading.ready()` releases the fade, so the frame is black — the land group
// is switched visible, every mesh under it has frustum culling suspended, and
// the whole mission scene is rendered ONCE with the binding the flight will
// use: a scratch 1×1 render target when the composer is going to draw the
// frame (any non-XR target gives three the `srgb-linear` / `NoToneMapping`
// key), or the default target otherwise (in a headset that IS the XR layer,
// on Classic it is the canvas). That single render compiles every lit program
// in the scene at its real key, runs the shadow pass so both depth variants
// compile, and uploads every buffer under the group. A `compile()` of the
// scene follows, still bound the same way, for materials on objects that are
// hidden for other reasons and would otherwise compile at first sight (the
// release frame compiled two more, 233 ms). Then every flag is put back.
//
// Nothing in the frame is different afterwards: same materials, same
// programs, same buffers — they exist a few seconds earlier, while nobody can
// see the frame. The `?ride=0` path and every retry already drew the world on
// their first frame under the same curtain; this makes the ride do what they
// were doing by accident.
//
// The draw is real, so it goes through `renderer.render()`: three exposes no
// public way to upload a geometry without drawing it. Rendering twice into
// the default framebuffer inside one animation frame shows only the second
// (the real frame overwrites), and the composer path binds its own target.
//
// ── And it has to be drawn under the FLIGHT's lights, not the room's ─────
//
// The second thing `compile()` taught. Three keys every lit program on the
// scene's light COUNTS (`numPointLights` is in the cache key), and the mission
// scene's point lights are the launch room's lamp and the cockpit's two cabin
// lamps (DEV-088). In the shaft that is three; the reveal hides the room and
// its lamp, so the flight is drawn with two — and at that frame every lit
// material in view, hidden or not, gets a new key and a fresh compile. A
// warm-up drawn with the room visible built 33 programs and the reveal still
// compiled 17 (measured, `after3`). So the caller hands over what to hide for
// the draw (`hide`: the launch room) and puts the ship in first person first,
// and the variants this builds are the ones the flight uses. The room's own
// variants still compile where they always did: on the first live frame in
// the shaft, under the same black curtain.
//
// ── And the binding a SESSION uses is not the one it composites to ───────
//
// DEV-239. Everything above is about ONE binding, chosen from
// `bloom.willComposite()` — which is `!renderer.xr.isPresenting && …`, and this
// function runs under the loading curtain, before `#enter-vr` has been pressed.
// So on every Anniversary load it warms the COMPOSER's linear target, and a
// session never draws through the composer: three gives an XR render target the
// CANVAS's `toneMapping` and `outputColorSpace`, and gives every other target
// `NoToneMapping` and the working colour space.
//
// Measured on `int_01_hoverJet` with the recorder armed inside a real session:
// **105 warm keys at `srgb-linear` / no tone mapping — the whole warm-up, and
// exactly the flat run's count — and a session can use none of them.** 39 were
// rebuilt at `srgb` / ACES on entering VR and four more compiled in the air,
// one of which is the 133 ms frame `docs/plan/VR-PERF-TAIL.md` §4.6 names.
// `alsoDefaultTarget` adds a second compile pass at the session's key.

import * as THREE from 'three'

/**
 * The slice of `WebGLRenderer` this uses. A `Pick`, like `bloom.ts`'s
 * `BloomRenderer`, so the unit test can hand in a fake and assert what was
 * bound, drawn and restored without a GL context.
 */
export interface WarmUpRenderer
  extends Pick<THREE.WebGLRenderer, 'render' | 'compile' | 'setRenderTarget' | 'getRenderTarget'> {
  readonly info: Pick<THREE.WebGLRenderer['info'], 'programs' | 'memory'>
}

export interface WarmUpOptions {
  /**
   * True when the frame will be drawn through the bloom composer into a
   * linear render target (`Bloom.willComposite()`): the programs must then be
   * compiled with a render target bound or three builds the canvas variant and
   * the real one still compiles at the reveal.
   */
  readonly offscreen: boolean
  /**
   * Objects to hide for the draw and restore after — the launch room, whose
   * lamp would otherwise be counted into every program's key. Optional; a
   * mission with no shaft has nothing to hide.
   */
  readonly hide?: readonly THREE.Object3D[]
  /**
   * Objects to force INTO the warm draw — the mirror of `hide`, and DEV-250's
   * half of warming the HUD's first flight-layout raster.
   *
   * `root` is the only thing this function makes drawable, because DEV-117 was
   * about one hidden group. A panel that is already in the scene and already
   * visible still may not be DRAWN: three's `projectObject` wants three things
   * of a mesh, and the warm draw satisfies none of them by accident.
   *
   *   1. **`visible`.** The caller's own frame loop may not have run since the
   *      object was built.
   *   2. **The frustum.** `object.frustumCulled === false ||
   *      _frustum.intersectsObject( object )` — the flag SHORT-CIRCUITS the
   *      test, so suspending it makes the draw independent of where the camera
   *      happens to be pointing under the curtain. That matters: the camera at
   *      this point in boot is wherever the title or the lift left it, and
   *      "the cockpit panel is in front of the eye" is a fact about the FLIGHT.
   *   3. **`object.layers.test( camera.layers )`.** The HUD is moved onto
   *      `bloom.ts`'s `UI_LAYER` by a traverse that runs inside `bloom.render`,
   *      so whether it has happened yet depends on how many frames the loading
   *      screen got — which is a race, and a lost race here is a warm that
   *      silently warms nothing.
   *
   * **The OBJECT's mask is widened, never the CAMERA's**, and that is the one
   * decision in here worth arguing. `camera.layers.enable(…)` would also work
   * and would be wrong: `WebGLRenderer.projectObject` gathers lights inside
   * `if ( object.layers.test( camera.layers ) )`, so a camera that can suddenly
   * see one more layer can collect one more LIGHT — and the light COUNT is
   * field #36 of three's program cache key. That would rebuild every key this
   * function exists to build at the flight's count (DEV-043, DEV-152). Widening
   * the object's own mask cannot move a light, and `|=` keeps the object's real
   * layer so the restore is exact.
   *
   * The traverse suspends culling and widens masks on DRAWABLES only — a Light
   * in the subtree is left exactly as it was found, for the reason above.
   *
   * Everything is restored in the `finally`, like `hide` and `root`.
   */
  readonly show?: readonly THREE.Object3D[]
  /**
   * Compile something extra while the FLIGHT's render target and lights are
   * still bound. DEV-186 follow-up, and DEV-177(b) independently.
   *
   * Handed a `compile(root)` that is `renderer.compile(root, camera, scene)`
   * with the scene supplied for its lights, so a caller can warm a variant of
   * its own without knowing which target this function chose or that the
   * launch room is hidden right now.
   *
   * It is a callback and not a second call after `warmWorld` returns because
   * TWO things this function does are undone by the time it does return, and
   * both are in three's program cache key:
   *
   *   1. **The render target.** The `finally` puts the previous one back, and
   *      `WebGLPrograms.getParameters` reads `outputColorSpace` off whatever is
   *      bound at the moment of the compile. A warm outside builds the CANVAS
   *      variant while the Anniversary frame is drawn by the bloom composer
   *      into a linear target — DEV-117's first attempt, one layer out.
   *   2. **The light count.** When `shaftLit` is used the room goes back on
   *      BEFORE the `finally`, on purpose (that is what `shaftLit` is for), so
   *      a warm outside sees three point lights where the flight has two.
   *
   * **Measured on `int_01`, by key** (DEV-177(b)): the sea's four programs came
   * out `outputColorSpace = srgb` and `numPointLights = 3` against the flight's
   * `srgb-linear` / 2 — four programs the game never draws with — and the sea
   * still compiled three variants in the seat at mission t = 1.3 s, 15 s and
   * 56 s. Two of those are position-locked and are two of the stalls
   * `VR-PERF-WAVE-2.md` F7 lists. Fixing the colour space ALONE did not move
   * them, which is what named the light count.
   *
   * Two mistakes, one shape, and the reason this is a parameter rather than a
   * convention: an ordering you have to remember is one you will get wrong.
   */
  readonly duringWarm?: (compile: (root: THREE.Object3D) => void) => void
  /**
   * Roots to compile a SECOND time with `hide` put back — i.e. under the
   * SHAFT's lights rather than the flight's. DEV-152.
   *
   * The main draw hides the launch room so the programs it builds are the ones
   * the flight uses, which is what made DEV-117's two-second reveal go away.
   * The cost of that is exact and was left in: everything drawn DURING the ride
   * is lit by one more point light (Classic 0 -> 1, Anniversary 2 -> 3), and
   * `numPointLights` is field #36 of three's program cache key, so the shaft
   * needs its own variant of every material the player sees on the way up.
   *
   * Almost everything in the shaft draws on the first frame of the ride and
   * pays for that under the curtain. The start grid does not: the launch deck
   * is above and ahead of the lift, outside the frustum at the bottom of the
   * shaft, and it first draws about 44 m up — one program, 90-180 ms, mid-ride,
   * in the clear. So these roots get a compile with the room back on.
   *
   * `renderer.compile(root, camera, scene)` takes its MATERIALS from `root` and
   * its LIGHTS from `scene`, which is what keeps this to the handful of
   * materials that need it rather than a second set of the whole world.
   */
  readonly shaftLit?: readonly THREE.Object3D[]
  /**
   * Compile everything a SECOND time with the DEFAULT target bound — which is
   * the key an immersive session draws with. DEV-239.
   *
   * ── Why the default binding IS the session's ─────────────────────────
   *
   * Read out of `WebGLPrograms.getParameters`, and it is two lines:
   *
   *     toneMapping = material.toneMapped &&
   *       ( currentRenderTarget === null || currentRenderTarget.isXRRenderTarget )
   *         ? renderer.toneMapping : NoToneMapping
   *     outputColorSpace = currentRenderTarget === null
   *       ? renderer.outputColorSpace
   *       : ( currentRenderTarget.isXRRenderTarget
   *             ? currentRenderTarget.texture.colorSpace
   *             : ColorManagement.workingColorSpace )
   *
   * and `WebXRManager` builds its render target with
   * `colorSpace: renderer.outputColorSpace`. So an XR layer and the CANVAS
   * agree on both fields, and every other target — including this function's
   * own scratch one — gets `NoToneMapping` and the working colour space.
   *
   * ── The gap it closes, measured ──────────────────────────────────────
   *
   * `bloom.ts`'s `willComposite()` is `!renderer.xr.isPresenting && …`, so a
   * session never composites; and this warm-up runs under the LOADING CURTAIN,
   * which is before `#enter-vr` has been pressed. `offscreen` is therefore true
   * for every Anniversary load and **not one of the programs it builds can be
   * used by a session.** On `int_01_hoverJet` the live set at the moment the
   * recorder armed was 105 keys at `srgb-linear`/`NoToneMapping` — the entire
   * warm-up, and exactly the flat run's count — beside 39 rebuilt at
   * `srgb`/ACES when the session started, and four more that arrived in the
   * air (DEV-239, `docs/plan/VR-PERF-TAIL.md` §4.6).
   *
   * A `compile()` and not a second `render()`: the buffers are uploaded by the
   * first draw and are not a property of the binding, and the shadow-depth
   * programs are not either — the shadow pass binds the shadow MAP, which is a
   * plain render target under both paths and takes the same key.
   *
   * False leaves this function byte-identical to DEV-152's, which is what
   * `?xr=off` and any device with no `immersive-vr` should get: a build that
   * cannot enter a session must not pay for the session's programs.
   */
  readonly alsoDefaultTarget?: boolean
  /**
   * Issue every compile this warm would, and DRAW nothing. DEV-355.
   *
   * The warm-up was 41 % of a 3.4 s task on a course switch, and 91 % of THAT
   * was `getProgramInfoLog` — the first draw of a program waits for its link to
   * finish, and with ~100 programs to link that wait is seconds. Three links a
   * program only when something asks, so the fix is to ask early and not wait:
   * this pass runs the same bindings, the same hides, the same `duringWarm` and
   * the same `shaftLit` block with `compile()` where the real pass `render()`s,
   * which hands every link to the driver's own threads under
   * `KHR_parallel_shader_compile`. `programsLinked` then waits for them without
   * holding the thread, and the real pass that follows finds every program
   * linked: its draw is the buffer uploads and nothing else.
   *
   * Same function, one flag, so the two passes cannot disagree about a single
   * key — which is the whole of what makes the second one a cache hit.
   */
  readonly compileOnly?: boolean
  /**
   * Objects parented INTO `scene` for the warm and put back where they were
   * after. DEV-355, and it is the XR rig: the frame loop hangs the rig in
   * whichever stage it last drew, and a course is chosen from the room — so on
   * a switch the camera, and whatever rides on it, sat in the menu's scene
   * while the mission's was warmed. A mission boot never saw this; its rig was
   * in the mission scene all along.
   */
  readonly adopt?: readonly THREE.Object3D[]
  /**
   * What the RIDE shows that the flight does not — the launch room — shown,
   * last, for a compile of the whole scene under the lights the ride's first
   * frame has. DEV-355.
   *
   * The draw above is lit as the FLIGHT is lit, with the launch room hidden,
   * which is right for the reveal and is why this file's header says the
   * room's own variants "still compile where they always did: on the first
   * live frame in the shaft, under the same black curtain". On a course switch
   * that frame measured **1.6–2.1 s**: 25 programs, every one of them a warm
   * program with `numPointLights` one higher — the room's lamp. Under a
   * curtain it is black; in a headset it is two seconds of the compositor
   * holding the last frame it had.
   *
   * SHOWN rather than put back as found, because on a course switch it is not
   * found showing: the frame loop hides the launch room whenever the screen is
   * not the mission, and the switch is built from the room. The first cut put
   * `hide` back "as found" and compiled six programs, none of them these.
   *
   * `root` is IN it: since DEV-249 the land stays drawn through the ride with
   * only the bore's chunks hidden, so the ride draws the land under the room's
   * lamp too. `duringWarm` runs again, because the sea's variants are what the
   * bottom of the shaft draws. Meant for a `compileOnly` pass, where it costs
   * the thread nothing: `warmWorldLinked` gives it to its first pass only, so
   * the draw pass never compiles it synchronously.
   */
  readonly rideLit?: readonly THREE.Object3D[]
  /**
   * Roots that a compositing frame draws in bloom's UI PASS, compiled against
   * that pass's binding as well. DEV-938.
   *
   * With `offscreen` every program above is built against the composer's
   * linear target, but `bloom.ts` draws a `toneMapped: false` surface in a
   * second pass straight to the CANVAS with the camera on `layer` alone. Both
   * are in three's cache key: `outputColorSpace` comes off the bound target
   * (srgb on the canvas, the working space on a target), and the light counts
   * come off the camera's mask (`projectObject` collects a light only on a
   * layer the camera sees). So a HUD surface warmed only here was warmed in a
   * variant nothing draws.
   *
   * The HUD panel got away with it by drawing on the ride's first frame, under
   * the curtain. The race map did not: DEV-840 keeps it dark while the launch
   * phase is `waiting` or `rising`, so its first draw was the RELEASE, in the
   * clear, and `ride-hitch.spec.ts` counted the one program it compiled there.
   *
   * Ignored without `offscreen`: a frame that does not composite draws its UI
   * in the one pass, which the main draw already warmed.
   */
  readonly uiPass?: { readonly roots: readonly THREE.Object3D[]; readonly layer: number }
}

/** The slice of a three program `programsLinked` reads. */
export interface LinkingProgram {
  isReady(): boolean
}

/**
 * Wait, without holding the thread, until every program three holds has
 * finished linking. DEV-355.
 *
 * In CREATION order, and it stops at the first one still linking: programs are
 * handed to the driver in that order, and each `isReady()` is a round trip to
 * the GPU process, so asking all ~100 on every poll would itself be a stall.
 * Returns how many turns it waited. Without `KHR_parallel_shader_compile`,
 * three reports every program ready at once and this returns 0 — the link then
 * happens at first draw, as it always did.
 */
export const programsLinked = async (
  programs: () => readonly LinkingProgram[],
  wait: () => Promise<void>,
): Promise<number> => {
  let done = 0
  let waits = 0
  for (;;) {
    const list = programs()
    while (done < list.length && (list[done] as LinkingProgram).isReady()) done += 1
    if (done >= list.length) return waits
    waits += 1
    await wait()
  }
}

export interface WarmUpResult {
  /** Wall milliseconds the whole warm-up took, main thread. */
  readonly ms: number
  /** Programs three reports after, minus before. */
  readonly programs: number
  /** Geometries three reports after, minus before. */
  readonly geometries: number
  /** Meshes under `root` whose culling was suspended for the draw. */
  readonly meshes: number
  /**
   * DEV-250. Drawables under `show` that were forced into the draw — culling
   * suspended, layer mask widened to the camera's.
   *
   * Reported because the option's whole job is invisible when it works: a
   * `show` that names an object with no drawable under it warms nothing and
   * looks exactly like a `show` that worked. Zero with the arm off.
   */
  readonly shown: number
  /** Whether a render target was bound for the draw. */
  readonly offscreen: boolean
  /**
   * How many BINDINGS were compiled against — 1 normally, 2 when
   * `alsoDefaultTarget` added the session's. DEV-239.
   */
  readonly bindings: number
}

/**
 * The binding a SESSION draws with, for `alsoDefaultTarget`. `null`, the
 * canvas, unless `?multiview=1` installed multiview (DEV-986): then a session
 * draws through the multiview eye target, whose colour space is its own
 * (`render/multiview.ts`), so the session's programs are the multiview ones and
 * this is a 1 x 1 target carrying that key. Compiled against, never drawn.
 */
let sessionTarget: THREE.WebGLRenderTarget | null = null

/** DEV-986: `render/multiview.ts` sets it when it is installed with the extension. */
export const setSessionWarmTarget = (target: THREE.WebGLRenderTarget | null): void => {
  sessionTarget = target
}

/** The scratch target. 1×1: the pixels are never read, only the binding matters. */
let scratchTarget: THREE.WebGLRenderTarget | null = null

const scratch = (): THREE.WebGLRenderTarget => {
  scratchTarget ??= new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, stencilBuffer: false })
  return scratchTarget
}

/**
 * Draw the world once, hidden, so its programs and buffers exist before the
 * frame that first shows it.
 *
 * @param root  the group that is hidden until the reveal — the land terrain's
 *   group, which the props hang under. Switched visible for the draw and put
 *   back exactly as found.
 * @param now   a clock, so the unit test can hand in a fake; `performance.now`
 *   in the app.
 */
export const warmWorld = (
  renderer: WarmUpRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  root: THREE.Object3D,
  options: WarmUpOptions,
  now: () => number,
): WarmUpResult => {
  const t0 = now()
  const programsBefore = renderer.info.programs?.length ?? 0
  const geometriesBefore = renderer.info.memory.geometries

  // ── into the scene for the warm, and back to wherever they were ─────────
  const adopted: [THREE.Object3D, THREE.Object3D | null][] = []
  for (const o of options.adopt ?? []) {
    adopted.push([o, o.parent])
    scene.add(o)
  }

  // ── suspend what would keep the world from being drawn ────────────────
  const rootWasVisible = root.visible
  root.visible = true
  const hidden: [THREE.Object3D, boolean][] = []
  for (const o of options.hide ?? []) {
    hidden.push([o, o.visible])
    o.visible = false
  }
  const culled: THREE.Object3D[] = []
  /** Drawables only: a Mesh, a Line or a Points — never a Group and never a Light. */
  const isDrawable = (o: THREE.Object3D): boolean =>
    (o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints
  root.traverse((o) => {
    // Drawables only: three consults `frustumCulled` on a Mesh, Line or Points
    // and never on a Group, so a group's flag is left alone and not counted.
    if (isDrawable(o) && o.frustumCulled) {
      o.frustumCulled = false
      culled.push(o)
    }
  })

  // DEV-117's own number, taken BEFORE `show` appends to the same list. A
  // subtraction at the end would have been wrong by however many `show`
  // drawables were already unculled by their owner — which is a difference
  // that shows up as a plausible count in a console line and nowhere else.
  const rootMeshes = culled.length

  // ── and the things the caller wants IN the draw (DEV-250) ─────────────
  //
  // Visibility, culling and the layer mask, each saved as found. See the
  // `show` option for why the object's mask is widened and the camera's is
  // left alone — a camera that can see one more layer can collect one more
  // LIGHT, and the light count is in three's program cache key.
  const shownVisible: [THREE.Object3D, boolean][] = []
  const shownLayers: [THREE.Object3D, number][] = []
  let shown = 0
  for (const o of options.show ?? []) {
    // **The whole ANCESTOR CHAIN, not just the object.** `projectObject`
    // returns on `object.visible === false` BEFORE it recurses into children,
    // so one hidden node anywhere above is the entire subtree gone — and gone
    // silently, which would leave `shown` reporting a forced draw that the
    // renderer skipped. That is the plausible-wrong-answer shape, so it is
    // closed rather than assumed away: the HUD hangs off the ship group,
    // several nodes below the scene, and which of those the frame loop has
    // touched by the time the world finishes building is a race.
    //
    // Only nodes this actually CHANGES are recorded, so the restore puts back
    // what was found and nothing else.
    for (let node: THREE.Object3D | null = o; node !== null; node = node.parent) {
      if (node.visible) continue
      shownVisible.push([node, false])
      node.visible = true
    }
    o.traverse((child) => {
      if (!isDrawable(child)) return
      shown += 1
      if (child.frustumCulled) {
        child.frustumCulled = false
        culled.push(child)
      }
      shownLayers.push([child, child.layers.mask])
      // `|=`, not `=`: the object keeps its own layer and gains the camera's,
      // so `layers.test( camera.layers )` is true and the restore is exact. A
      // camera with an empty mask draws nothing at all, so the no-op this
      // becomes there is the right answer rather than a missed case.
      child.layers.mask |= camera.layers.mask
    })
  }

  // ── the bindings to compile against, in order ─────────────────────────
  //
  // One normally. Two when `alsoDefaultTarget` asks for the SESSION's key as
  // well — and that second one is `null`, the canvas, because three gives an XR
  // render target the canvas's `toneMapping` and `outputColorSpace`. See the
  // option's own comment for the two lines of `getParameters` that say so.
  //
  // The FIRST entry is always the one the flat frame will use, so the real draw
  // and everything DEV-117 and DEV-152 measured happen exactly where they did.
  // A build that does not composite is already on the default target, so there
  // is nothing to add and the list stays at one.
  const bindings: (THREE.WebGLRenderTarget | null)[] = options.offscreen ? [scratch()] : [null]
  // Under multiview the session's key is never the flat frame's, composited or
  // not, so its binding is added either way (DEV-986).
  if (options.alsoDefaultTarget === true && (options.offscreen || sessionTarget !== null)) {
    bindings.push(sessionTarget)
  }

  const previousTarget = renderer.getRenderTarget()
  try {
    renderer.setRenderTarget(bindings[0] as THREE.WebGLRenderTarget | null)
    // DEV-355's first pass compiles what this draw would, and draws nothing.
    if (options.compileOnly === true) renderer.compile(scene, camera)
    else renderer.render(scene, camera)
    // Materials hidden for their own reasons — the platform after release, a
    // results plate — compile here rather than on the frame they first show.
    // Cheap for everything the draw above already compiled: a cache hit.
    renderer.compile(scene, camera)
    // Anything a caller wants compiled against THIS target and THIS light
    // count, BEFORE the `shaftLit` block puts the room back on. See
    // `duringWarm` — the two things that make this position matter are the
    // render target and the point-light count, and both are undone below.
    options.duringWarm?.((root) => {
      renderer.compile(root, camera, scene)
    })
    // ── and again at every other binding (DEV-239) ────────────────────────
    //
    // `compile` and not `render`: a second draw would upload nothing new and
    // would put pixels on the canvas under a curtain that is about to lift.
    // `duringWarm` runs again because the variants it builds — the sea's four
    // and both LOD-fade clones — are materials, and a material's program is per
    // binding like every other.
    for (const extra of bindings.slice(1)) {
      renderer.setRenderTarget(extra)
      renderer.compile(scene, camera)
      options.duringWarm?.((root) => {
        renderer.compile(root, camera, scene)
      })
    }
    // ── bloom's UI pass: the canvas, the camera on the UI layer (DEV-938) ──
    //
    // Before `shaftLit` puts the room back, so the lights are the FLIGHT's as
    // the camera's mask filters them. The mask is the camera's own, set and
    // restored, which is exactly what `bloom.render` does for that pass.
    if (options.offscreen && (options.uiPass?.roots.length ?? 0) > 0 && options.uiPass) {
      const mask = camera.layers.mask
      renderer.setRenderTarget(null)
      camera.layers.set(options.uiPass.layer)
      try {
        for (const r of options.uiPass.roots) renderer.compile(r, camera, scene)
      } finally {
        camera.layers.mask = mask
      }
    }
    // ── the SHAFT's own variants (DEV-152) ────────────────────────────────
    //
    // Put the room back FIRST, so its lamp is in the light count, then compile
    // only the roots that are drawn during the ride but not on its first frame.
    // Once per binding, because the binding is in the key too (DEV-117) and the
    // ride is drawn in a session as readily as on a monitor.
    if ((options.shaftLit?.length ?? 0) > 0) {
      for (const [o, was] of hidden) o.visible = was
      hidden.length = 0
      for (const binding of bindings) {
        renderer.setRenderTarget(binding)
        for (const root of options.shaftLit ?? []) {
          const wasVisible = root.visible
          root.visible = true
          try {
            renderer.compile(root, camera, scene)
          } finally {
            root.visible = wasVisible
          }
        }
      }
    }
    // ── the first frame of the ride (DEV-355) ────────────────────────────
    //
    // The room SHOWN, so the lights three collects are the shaft's, and put
    // back as it was found afterwards. See `rideLit`.
    if ((options.rideLit?.length ?? 0) > 0) {
      for (const [o, was] of hidden) o.visible = was
      hidden.length = 0
      const lit: [THREE.Object3D, boolean][] = (options.rideLit ?? []).map((o) => [o, o.visible])
      for (const [o] of lit) o.visible = true
      try {
        for (const binding of bindings) {
          renderer.setRenderTarget(binding)
          renderer.compile(scene, camera)
          options.duringWarm?.((r) => {
            renderer.compile(r, camera, scene)
          })
        }
      } finally {
        for (const [o, was] of lit) o.visible = was
      }
    }
  } finally {
    renderer.setRenderTarget(previousTarget)
    for (const o of culled) o.frustumCulled = true
    // DEV-250's two lists go back BEFORE `hide`'s, so that an object named in
    // both — which is a caller contradiction rather than a case, since `show`
    // is applied after `hide` and therefore wins for the draw — ends on the
    // value it had before either touched it.
    for (const [o, mask] of shownLayers) o.layers.mask = mask
    for (const [o, was] of shownVisible) o.visible = was
    for (const [o, was] of hidden) o.visible = was
    root.visible = rootWasVisible
    for (const [o, parent] of adopted) {
      if (parent) parent.add(o)
      else scene.remove(o)
    }
  }

  return {
    ms: now() - t0,
    programs: (renderer.info.programs?.length ?? 0) - programsBefore,
    geometries: renderer.info.memory.geometries - geometriesBefore,
    meshes: rootMeshes,
    shown,
    offscreen: options.offscreen,
    bindings: bindings.length,
  }
}

export interface LinkedWarmUpResult extends WarmUpResult {
  /** Polls spent waiting for the links, off the thread. 0 if they were done at once. */
  readonly linkWaits: number
  /** Wall milliseconds from the first compile to the last link, pauses included. */
  readonly linkMs: number
}

/**
 * The warm-up with the link wait off the thread. DEV-355.
 *
 * `compileOnly` first — every program the real pass would build, handed to the
 * driver and not waited on — then `programsLinked`, which lets frames through
 * while the driver's own threads link them, then the real pass, which now finds
 * every program linked and draws only to upload. `programs` is every pass's
 * count, so the line the app prints means what it always meant.
 *
 * ── The compile-only work is itself split, by what it builds ─────────────
 *
 * Handing a program to the driver is cheap; BUILDING its source is not —
 * three's include expansion, loop unrolling and light-count substitution, plus
 * this repo's `onBeforeCompile` chains, are a few milliseconds a program on the
 * main thread, and one pass building ~120 of them measured a 330 ms task. So
 * the compile-only work runs as up to four passes with a turn between each:
 * the flight's key at the first binding, then at the session's (DEV-239) if
 * asked for, then the ride's (`rideLit`) at each in the same order. Each pass
 * repeats the ones before it as cache hits, which costs a key lookup per
 * material, and builds only what is new to it. Split no finer than a pass:
 * inside one, the room is hidden and the rig adopted, and a frame must never
 * see that half-applied.
 */
export const warmWorldLinked = async (
  renderer: WarmUpRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  root: THREE.Object3D,
  options: WarmUpOptions,
  now: () => number,
  wait: () => Promise<void>,
): Promise<LinkedWarmUpResult> => {
  const t0 = now()
  const passes: WarmUpOptions[] = [
    { ...options, compileOnly: true, alsoDefaultTarget: false, rideLit: [] },
  ]
  const session = options.alsoDefaultTarget === true
  if (session) passes.push({ ...options, compileOnly: true, rideLit: [] })
  if ((options.rideLit?.length ?? 0) > 0) {
    passes.push({ ...options, compileOnly: true, alsoDefaultTarget: false })
    if (session) passes.push({ ...options, compileOnly: true })
  }
  let issuedPrograms = 0
  for (const [i, pass] of passes.entries()) {
    if (i > 0) await wait()
    issuedPrograms += warmWorld(renderer, scene, camera, root, pass, now).programs
  }
  const linkWaits = await programsLinked(
    () => (renderer.info.programs ?? []) as unknown as readonly LinkingProgram[],
    wait,
  )
  const linkMs = now() - t0
  const drawn = warmWorld(
    renderer,
    scene,
    camera,
    root,
    { ...options, compileOnly: false, rideLit: [] },
    now,
  )
  return {
    ...drawn,
    ms: now() - t0,
    programs: issuedPrograms + drawn.programs,
    linkWaits,
    linkMs,
  }
}
