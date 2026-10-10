/**
 * A remote player's name tag is hidden by whatever stands in front of it
 * (DEV-388 follow-up; Matt, 2026-09-27: *"hide name tags everywhere (when they
 * should be obscured)"*).
 *
 * Two browsers in one room. A flies the course from GO (`?autopilot=1`); B
 * stays on the pad with its sim frozen a second after its own release
 * (`?snap=1`), so B's view holds perfectly still while A's ship — drawn off
 * the room clock, not B's sim — flies away up the course, behind the islands
 * and out again. Every 200 ms the spec asks B's page where A's tag is on screen
 * and whether DRAWN terrain stands between B's eye and it: nine raycasts, with
 * the page's own three, against the terrain chunks as they are drawn, across
 * the tag's whole extent. When every ray meets the island well in front of the
 * tag, and when none meets anything, it photographs the tag's patch of screen
 * twice — as drawn, and with the tag's opacity at zero — and counts the pixels
 * the tag's dark plate darkened:
 *
 *   hidden by terrain   the tag darkens nothing (it is behind the hill)
 *   open air            it darkens many (it is there to be read)
 *
 * RED on the code this replaced: the tag was a UI-layer object
 * (`toneMapped: false`, `render/bloom.ts`'s `classify()`), drawn after the
 * world with the depth cleared, so it showed through the island. Measured
 * 2026-09-27: behind the island 343, 320 and 295 pixels darkened on the old
 * material and 0, 4 and 0 on the new; in open air 245, 116 and 39.
 *
 * The first two versions of this premise were wrong in instructive ways, and
 * both are in the header of `sight` below: the collision height field is not
 * the drawn surface 2 km out, and a tag whose CENTRE is behind a ridge can
 * have its plate above it.
 *
 * The room is the sidecar (`fixtures/room-sidecar.ts`), as the other room specs.
 *
 *   FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5388 ROOM_PHOTO_DIR=<dir> \
 *     npx playwright test room-tag-occlusion
 *
 * Photographs are pinned (`PINNED`) and taken from B's seat. Tagged `@gpu`.
 */

import fs from 'node:fs'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { E2E_BASE as BASE, E2E_CHANNEL as CHANNEL } from './fixtures/server'
import { type Browser, chromium, expect, type Page, skipSplash, test } from './fixtures/test'

const PROXY = process.env.FF2_API_PROXY ?? ''
const PHOTOS = process.env.ROOM_PHOTO_DIR ?? null
const PINNED = 'xr=off&adaptive=0&quality=high&mission=int_01_hoverJet&menu=0'

/**
 * Metres short of the tag that EVERY ray across it must meet drawn terrain,
 * for "hidden": the island is well in front, not a ridge the tag is about to
 * clear. Generous; the moments this course offers are 350 to 1,750 m in front.
 */
const HIDDEN_BY_M = 300
/** Metres off a clear tag must be: past the pad, so it is A in flight. */
const CLEAR_BEYOND_M = 200
/** Luminance (0-255) a pixel must drop by to count as darkened by the tag's plate. */
const PIXEL_DELTA = 24
/** The half-size of the patch photographed around the tag's centre, CSS px. */
const PATCH = { w: 40, h: 16 }

interface Probe {
  owner: number | null
  slot: number | null
  settings: unknown
  goAt: number | null
  goRoom: number | null
  tick: number | null
}
const probe = (page: Page): Promise<Probe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2?: { room: () => unknown } }
    const r = w.__ff2?.room() as Record<string, unknown> | null | undefined
    if (!r) return null
    const { ready: _r, start: _s, truth: _t, resetStats: _x, ...plain } = r
    return JSON.parse(JSON.stringify(plain)) as Probe
  })
/** DEV-391: the owner's Bots row, off: this spec races people only (bots: `room-bots.spec.ts`). */
const botsOff = async (owner: Page, other: Page): Promise<void> => {
  await owner.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: { room: () => { bots: (on: boolean) => void } | null }
    }
    w.__ff2.room()?.bots(false)
  })
  for (const p of [owner, other]) {
    await expect
      .poll(async () => ((await probe(p))?.settings as { bots?: boolean } | null)?.bots)
      .toBe(false)
  }
}

const call = (page: Page, verb: 'ready' | 'start') =>
  page.evaluate((v) => {
    const w = globalThis as unknown as {
      __ff2: { room: () => { ready: () => void; start: () => void } | null }
    }
    w.__ff2.room()?.[v]()
  }, verb)

interface Sight {
  /**
   * Metres from the eye to the first piece of DRAWN terrain on the line to the
   * tag's centre, or null for none: a raycast against the terrain chunks as
   * drawn, not the collision height field. The first version sampled
   * `heightField` along the sightline; the second cast this one ray. Both
   * called "hidden" a tag whose plate was plainly on screen, because a tag is
   * several degrees wide and its centre can sit just behind a ridge's edge
   * while the plate stands above it (and 100 ms later, all of it). What
   * decides is `blockedBy`, below; this one is kept for the log.
   */
  readonly hit: number | null
  /**
   * Over nine rays across the tag's whole extent and half a degree beyond, the
   * farthest of their nearest terrain hits: every ray is blocked at least this
   * close. Null when any ray gets through.
   */
  readonly blockedBy: number | null
  /** No ray across the tag's extent meets drawn terrain. */
  readonly clearAll: boolean
  /** Metres from the eye to the tag. */
  readonly metres: number
  /** The tag's centre in CSS pixels, and whether it is in front of the eye and on screen. */
  readonly x: number
  readonly y: number
  readonly onScreen: boolean
}

/** Where A's tag is on B's screen, and whether drawn terrain stands in the way. */
const sight = (page: Page): Promise<Sight | null> =>
  page.evaluate(async () => {
    // three, as the page itself loaded it: the same module, so the same classes.
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => /\/deps\/three\.js/.test(n))
    if (!url) return null
    const load = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>
    // biome-ignore lint/suspicious/noExplicitAny: three's module, typed at the page's side
    const T = (await load(url)) as any
    // biome-ignore lint/suspicious/noExplicitAny: page objects
    const w = globalThis as any
    // biome-ignore lint/suspicious/noExplicitAny: page objects
    let cam: any = null
    // biome-ignore lint/suspicious/noExplicitAny: page objects
    let tag: any = null
    w.__ff2.stage().traverse(
      // biome-ignore lint/suspicious/noExplicitAny: page objects
      (o: any) => {
        if (o.isPerspectiveCamera && !cam) cam = o
        if (o.name === 'room-name-tag' && o.visible) tag = o
      },
    )
    const group = w.__ff2.terrain()?.terrain.group
    if (!cam || !tag || !group) return null
    cam.updateMatrixWorld(true)
    const eye = cam.getWorldPosition(new T.Vector3())
    const at = tag.getWorldPosition(new T.Vector3())
    const dir = at.clone().sub(eye)
    const metres = dir.length()
    dir.normalize()
    // biome-ignore lint/suspicious/noExplicitAny: page objects
    const meshes: any[] = []
    // biome-ignore lint/suspicious/noExplicitAny: page objects
    group.traverseVisible((o: any) => {
      if (o.isMesh) meshes.push(o)
    })
    const ray = new T.Raycaster(eye, dir, 20, metres)
    const hits = ray.intersectObjects(meshes, false)
    // The WHOLE tag, not its centre: nine rays over its extent and half a
    // degree beyond (`sizeAttenuation: false` makes its scale an angle), each
    // with its own nearest hit. A tag whose centre is behind a ridge's edge
    // can be above it 100 ms later; one deep inside the silhouette cannot.
    const up = new T.Vector3(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(new T.Quaternion()))
    const right = dir.clone().cross(up).normalize()
    const up2 = right.clone().cross(dir).normalize()
    const hx = tag.scale.x / 2 + 0.009
    const hy = tag.scale.y / 2 + 0.009
    let deepest = Number.NEGATIVE_INFINITY
    let anyHit = false
    for (const ox of [-hx, 0, hx]) {
      for (const oy of [-hy, 0, hy]) {
        const d = dir.clone().addScaledVector(right, ox).addScaledVector(up2, oy).normalize()
        const r = new T.Raycaster(eye, d, 20, metres)
        const h = r.intersectObjects(meshes, false)[0]
        if (h) anyHit = true
        // The FARTHEST of the nine nearest hits: every ray is blocked at least this soon.
        deepest = Math.max(deepest, h ? (h.distance as number) : Number.POSITIVE_INFINITY)
      }
    }
    const ndc = at.clone().project(cam)
    const h0 = hits[0]
    const hm = h0?.object?.material
    const debug = {
      hitName: h0?.object?.name ?? null,
      hitMat: hm
        ? {
            type: hm.type,
            transparent: hm.transparent,
            depthWrite: hm.depthWrite,
            depthTest: hm.depthTest,
            opacity: hm.opacity,
            layers: h0.object.layers.mask,
            renderOrder: h0.object.renderOrder,
          }
        : null,
      tag: {
        layers: tag.layers.mask,
        toneMapped: tag.material.toneMapped,
        depthTest: tag.material.depthTest,
        renderOrder: tag.renderOrder,
      },
      fog: w.__ff2.stage().fog ? 'scene fog' : 'none',
    }
    return {
      debug,
      hit: hits.length > 0 ? (hits[0].distance as number) : null,
      blockedBy: Number.isFinite(deepest) ? deepest : null,
      clearAll: !anyHit,
      metres,
      x: ((ndc.x + 1) / 2) * window.innerWidth,
      y: ((1 - ndc.y) / 2) * window.innerHeight,
      onScreen: ndc.z < 1 && Math.abs(ndc.x) < 0.85 && Math.abs(ndc.y) < 0.8,
    }
  })

/** Set A's tag's opacity on B's page (the harness's A/B, not the game's). */
const tagOpacity = (page: Page, opacity: number) =>
  page.evaluate((o) => {
    const w = globalThis as unknown as {
      __ff2: {
        stage: () => {
          traverse(
            f: (x: { name: string; material?: { opacity: number; needsUpdate: boolean } }) => void,
          ): void
        }
      }
    }
    w.__ff2.stage().traverse((x) => {
      if (x.name === 'room-name-tag' && x.material) x.material.opacity = o
    })
  }, opacity)

/** Pixels that differ between the tag's patch drawn and hidden. */
let patches = 0
const tagPixels = async (page: Page, s: Sight): Promise<{ changed: number; of: number }> => {
  const clip = {
    x: Math.max(0, s.x - PATCH.w),
    y: Math.max(0, s.y - PATCH.h),
    width: PATCH.w * 2,
    height: PATCH.h * 2,
  }
  const n = ++patches
  const shownPng = await page.screenshot({ clip })
  const shown = decodePngBuffer(shownPng, 'shown')
  await tagOpacity(page, 0)
  await page.waitForTimeout(120)
  const hiddenPng = await page.screenshot({ clip })
  const hidden = decodePngBuffer(hiddenPng, 'hidden')
  await tagOpacity(page, 1)
  if (PHOTOS) {
    fs.writeFileSync(`${PHOTOS}/tag-patch-${n}-shown.png`, shownPng)
    fs.writeFileSync(`${PHOTOS}/tag-patch-${n}-hidden.png`, hiddenPng)
  }
  // A pixel the TAG changed is one its dark plate DARKENED: 72 % of near-black
  // over whatever is behind it. The gate's sparkles, which drift between the
  // two photographs, only ever brighten, so they are not counted.
  const lum = (d: Uint8Array, ch: number, i: number) =>
    0.2126 * (d[i * ch] as number) +
    0.7152 * (d[i * ch + 1] as number) +
    0.0722 * (d[i * ch + 2] as number)
  const W = shown.width
  const px = W * shown.height
  const dark = new Uint8Array(px)
  for (let i = 0; i < px; i++) {
    const a = lum(shown.data, shown.channels, i)
    const b = lum(hidden.data, hidden.channels, i)
    if (b - a > PIXEL_DELTA && a < b * 0.7) dark[i] = 1
  }
  // A plate is a patch, not a speck: count a darkened pixel only with at
  // least two darkened neighbours, so a sparkle that moved between the two
  // photographs (a bright dot in one, gone in the other) is not a tag.
  let changed = 0
  for (let i = 0; i < px; i++) {
    if (!dark[i]) continue
    const x = i % W
    const n =
      (x > 0 ? (dark[i - 1] as number) : 0) +
      (x < W - 1 ? (dark[i + 1] as number) : 0) +
      (i >= W ? (dark[i - W] as number) : 0) +
      (i + W < px ? (dark[i + W] as number) : 0)
    if (n >= 2) changed++
  }
  return { changed, of: px }
}

const open = async (
  x: number,
  roomId: string,
  extra: string,
): Promise<{ browser: Browser; page: Page }> => {
  const browser = await chromium.launch({
    headless: false,
    ...(CHANNEL ? { channel: CHANNEL } : {}),
    args: [`--window-position=${x},0`, '--window-size=900,640'],
  })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 880, height: 520 },
  })
  await skipSplash(context)
  const page = await context.newPage()
  page.on('console', (m) => {
    const t = m.text()
    if (/^room|opponents|lap:|autopilot|snap/.test(t)) console.log(`[${x}] ${t}`)
  })
  await page.goto(`${BASE}/?${PINNED}&room=${roomId}${extra}`)
  await firstPress(page)
  return { browser, page }
}

test.describe('@gpu a name tag behind a hill is hidden', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.setTimeout(480_000)

  let sidecar: RoomSidecar
  test.beforeAll(async () => {
    // Long enough to wait out another room spec holding the sidecar port
    // (`startRoomSidecar` waits for it rather than failing EADDRINUSE).
    test.setTimeout(360_000)
    sidecar = await startRoomSidecar(Number(new URL(PROXY).port))
    const answer = await fetch(`${PROXY}/api/room-sidecar`).then((r) => r.text())
    expect(answer, 'a stale sidecar is answering on this port').toBe(sidecar.nonce)
  })
  test.afterAll(async () => {
    await sidecar?.close()
  })

  test('terrain hides a remote ship’s tag; in open air it reads', async () => {
    const roomId = `t${Date.now().toString(32)}abcdefghij`.slice(0, 16).replace(/[^a-z2-7]/g, 'a')
    const a = await open(0, roomId, '&autopilot=1')
    await expect.poll(async () => (await probe(a.page))?.owner, { timeout: 180_000 }).toBe(0)
    const b = await open(920, roomId, '&snap=1')
    try {
      for (const p of [a.page, b.page]) {
        await missionReady(p, 240_000)
      }
      await expect.poll(async () => (await probe(b.page))?.slot, { timeout: 60_000 }).toBe(1)
      await expect.poll(async () => (await probe(a.page))?.settings !== null).toBe(true)
      await expect.poll(async () => (await probe(b.page))?.settings !== null).toBe(true)
      await botsOff(a.page, b.page)
      await call(a.page, 'ready')
      await call(b.page, 'ready')
      await expect
        .poll(
          async () => {
            await call(a.page, 'start')
            return (await probe(a.page))?.goAt ?? null
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .not.toBeNull()
      for (const p of [a.page, b.page]) {
        await expect
          .poll(async () => (await probe(p))?.goRoom ?? null, { timeout: 60_000 })
          .not.toBeNull()
      }

      // ── watch A fly away from B's still seat ─────────────────────────
      //
      // Up to three moments of each kind. HIDDEN: drawn terrain crosses the
      // sightline at least HIDDEN_BY_M short of the tag. CLEAR: nothing drawn
      // crosses it, and the tag is far enough off to be A's in flight. A clear
      // moment can still put the tag behind a cockpit strut, so open air asks
      // for the BEST of its samples; a hidden one asks it of every sample.
      type Moment = { s: Sight; px: { changed: number; of: number } }
      const hidden: Moment[] = []
      const clear: Moment[] = []
      const seen: string[] = []
      const deadline = Date.now() + 75_000
      while (Date.now() < deadline && (hidden.length < 3 || clear.length < 3)) {
        const s = await sight(b.page)
        if (s?.onScreen) {
          seen.push(
            `${s.metres.toFixed(0)} m, ${s.hit === null ? 'clear' : `terrain at ${s.hit.toFixed(0)} m`}`,
          )
          if (hidden.length < 3 && s.blockedBy !== null && s.blockedBy < s.metres - HIDDEN_BY_M) {
            hidden.push({ s, px: await tagPixels(b.page, s) })
            if (PHOTOS && hidden.length === 1)
              await b.page.screenshot({ path: `${PHOTOS}/room-tag-hidden-adaptive0-high.png` })
            await b.page.waitForTimeout(1500)
          } else if (clear.length < 3 && s.clearAll && s.metres > CLEAR_BEYOND_M) {
            clear.push({ s, px: await tagPixels(b.page, s) })
            if (PHOTOS && clear.length === 1)
              await b.page.screenshot({ path: `${PHOTOS}/room-tag-clear-adaptive0-high.png` })
            await b.page.waitForTimeout(1500)
          }
        }
        await b.page.waitForTimeout(200)
      }
      console.log(
        `sightline samples (${seen.length}): ${seen.filter((_, i) => i % 8 === 0).join(' · ')}`,
      )
      console.log(`hidden: ${JSON.stringify(hidden)}\nclear: ${JSON.stringify(clear)}`)
      expect(clear.length, 'no open-air moment on screen: the premise failed').toBeGreaterThan(0)
      expect(
        hidden.length,
        'no moment with drawn terrain between the eye and the tag: the premise failed',
      ).toBeGreaterThan(0)
      // Open air: the tag is there to be read.
      expect(Math.max(...clear.map((m) => m.px.changed))).toBeGreaterThan(60)
      // Behind the hill: the tag changes nothing on screen, every time.
      for (const m of hidden) expect(m.px.changed, JSON.stringify(m.s)).toBeLessThanOrEqual(5)
    } finally {
      await a.browser.close()
      await b.browser.close()
    }
  })
})
