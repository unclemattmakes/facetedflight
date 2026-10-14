// tools/perf/xr-multiview-spike.mjs: the multiview spike (DEV-985).
//
//   bash tools/agent/gpu.sh run <name> 10 -- node tools/perf/xr-multiview-spike.mjs <outDir>
//
// Needs a real immersive device (the VRto3D rig, docs/vr-testing.md). Asks two questions
// with raw WebGL2 and no three.js: does Chrome give a `texture-array` projection layer, and
// is a `framebufferTextureMultiviewOVR` framebuffer on its colour and depth textures
// complete? One draw, `gl_ViewID_OVR` offsets the triangle and picks a colour per eye
// (red left, green right); frame 60 reads each array layer back in-page
// (`framebufferTextureLayer` + `readPixels`) and writes `<outDir>/spike.json` plus a 64 px
// `eyeN.ppm` per layer. The page is served by `route.fulfill` on a secure localhost
// origin, so no dev server runs; the `vr` grant is the one `fixtures/xr-browser.ts` writes.
//
// Answer on 2026-10-14 (Chrome 155, ANGLE D3D11, RTX 5050): both YES. `requiredFeatures:
// ['layers']` is refused (NotSupportedError); without it `createProjectionLayer` works.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'

const OUT = process.argv[2] ?? '.'
fs.mkdirSync(OUT, { recursive: true })
const ORIGIN = 'https://localhost:5330'
const PROFILE = path.join(os.tmpdir(), 'ff2-xr-profile')
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true })
fs.writeFileSync(
  path.join(PROFILE, 'Default', 'Preferences'),
  JSON.stringify({
    profile: { content_settings: { exceptions: { vr: { [`${ORIGIN},*`]: { setting: 1 } } } } },
  }),
)

const HTML = `<!doctype html><html><body style="margin:0;background:#222">
<button id="go" style="font-size:40px;width:100%;height:200px">enter</button>
<pre id="log" style="color:#fff"></pre>
<script>
const out = { steps: [] }
window.__spike = out
const log = (k, v) => { out.steps.push([k, v]); document.getElementById('log').textContent += k + ': ' + JSON.stringify(v) + '\\n' }
const canvas = document.createElement('canvas')
const gl = canvas.getContext('webgl2', { xrCompatible: true, antialias: false, depth: true })
const mv = gl.getExtension('OVR_multiview2')
log('ext', !!mv)
if (mv) log('MAX_VIEWS_OVR', gl.getParameter(mv.MAX_VIEWS_OVR))
log('renderer', gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER))
log('ua', navigator.userAgent)
const vs = \`#version 300 es
#extension GL_OVR_multiview2 : require
layout(num_views = 2) in;
in vec2 p;
flat out int vId;
void main() { vId = int(gl_ViewID_OVR); gl_Position = vec4(p + vec2(gl_ViewID_OVR == 0u ? -0.2 : 0.2, 0.0), 0.5, 1.0); }\`
const fs = \`#version 300 es
precision highp float;
flat in int vId;
out vec4 c;
void main() { c = vId == 0 ? vec4(1.0, 0.0, 0.0, 1.0) : vec4(0.0, 1.0, 0.0, 1.0); }\`
function sh(t, s) { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) log('shaderlog', gl.getShaderInfoLog(o)); return o }
const prog = gl.createProgram()
gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog)
log('link', gl.getProgramParameter(prog, gl.LINK_STATUS) ? 'ok' : gl.getProgramInfoLog(prog))
const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf)
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.0, 0.6]), gl.STATIC_DRAW)
const fb = gl.createFramebuffer()
const readFb = gl.createFramebuffer()
let frames = 0
const statusName = (s) => ({ [gl.FRAMEBUFFER_COMPLETE]: 'COMPLETE', [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT]: 'INCOMPLETE_ATTACHMENT', [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]: 'MISSING_ATTACHMENT', [gl.FRAMEBUFFER_UNSUPPORTED]: 'UNSUPPORTED', [mv?.FRAMEBUFFER_INCOMPLETE_VIEW_TARGETS_OVR]: 'INCOMPLETE_VIEW_TARGETS_OVR' })[s] ?? s
document.getElementById('go').onclick = async () => {
  try {
    log('supported', await navigator.xr.isSessionSupported('immersive-vr'))
    const session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['layers'] }).catch(async (e) => { log('layers-required-failed', String(e)); return navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['layers'] }) })
    log('session', session.enabledFeatures ?? 'n/a')
    const binding = new XRWebGLBinding(session, gl)
    let layer
    try {
      layer = binding.createProjectionLayer({ textureType: 'texture-array', colorFormat: gl.RGBA8, depthFormat: gl.DEPTH_COMPONENT24, scaleFactor: 1 })
      log('layer', { textureType: 'texture-array', w: layer.textureWidth, h: layer.textureHeight, arrayLength: layer.textureArrayLength, ignoreDepth: layer.ignoreDepthValues })
    } catch (e) { log('layer-threw', String(e)); await session.end(); out.done = true; return }
    session.updateRenderState({ layers: [layer] })
    const space = await session.requestReferenceSpace('local')
    session.requestAnimationFrame(function onFrame(t, frame) {
      frames++
      const pose = frame.getViewerPose(space)
      if (pose) {
        const views = pose.views
        const subs = views.map((v) => binding.getViewSubImage(layer, v))
        if (frames === 1) log('subimages', subs.map((s, i) => ({ i, imageIndex: s.imageIndex, vp: [s.viewport.x, s.viewport.y, s.viewport.width, s.viewport.height], sameColour: s.colorTexture === subs[0].colorTexture, hasDepth: !!s.depthStencilTexture })))
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb)
        mv.framebufferTextureMultiviewOVR(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, subs[0].colorTexture, 0, 0, 2)
        if (subs[0].depthStencilTexture) mv.framebufferTextureMultiviewOVR(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, subs[0].depthStencilTexture, 0, 0, 2)
        const st = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER)
        if (frames === 1 || frames === 30) log('fbStatus@' + frames, statusName(st))
        const vp = subs[0].viewport
        gl.viewport(vp.x, vp.y, vp.width, vp.height)
        gl.clearColor(0, 0, 0.3, 1); gl.clearDepth(1)
        gl.enable(gl.DEPTH_TEST)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
        gl.useProgram(prog)
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        const err = gl.getError(); if (frames === 1 || err) log('glError@' + frames, err)
        if (frames === 60) {
          // read each layer back: centre of the triangle in that eye, and the clear colour in a corner
          const res = []
          for (let i = 0; i < 2; i++) {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFb)
            gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, subs[0].colorTexture, 0, i)
            const rs = statusName(gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER))
            const W = vp.width, H = vp.height
            const px = (x, y) => { const a = new Uint8Array(4); gl.readPixels(Math.floor(x), Math.floor(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a); return Array.from(a) }
            // triangle centroid in NDC is (offset, 0.033): -0.2 for view 0, +0.2 for view 1
            const off = i === 0 ? -0.2 : 0.2
            const centre = px((off + 0.0 + 1) / 2 * W, (0.033 + 1) / 2 * H)
            const corner = px(4, 4)
            // a downscaled thumbnail, 64x64
            const N = 64, thumb = []
            for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) thumb.push(px((x + 0.5) / N * W, (y + 0.5) / N * H).slice(0, 3))
            res.push({ layer: i, readStatus: rs, centre, corner, thumb })
          }
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
          out.readback = res
          log('readback', res.map((r) => ({ layer: r.layer, readStatus: r.readStatus, centre: r.centre, corner: r.corner })))
        }
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
      }
      if (frames < 300) session.requestAnimationFrame(onFrame)
      else { log('frames', frames); session.end().then(() => { out.done = true }) }
    })
  } catch (e) { log('threw', String(e && e.stack || e)); out.done = true }
}
</script></body></html>`

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  channel: 'chrome',
  ignoreHTTPSErrors: true,
  viewport: { width: 800, height: 600 },
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
page.on('console', (m) => console.log('[console]', m.type(), m.text()))
await ctx.route('**/*', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: HTML }),
)
await page.goto(`${ORIGIN}/mv-spike.html`)
await page.click('#go')
const t0 = Date.now()
while (Date.now() - t0 < 150000) {
  const done = await page.evaluate(() => window.__spike.done === true)
  if (done) break
  await new Promise((r) => setTimeout(r, 500))
}
const res = await page.evaluate(() => window.__spike)
fs.writeFileSync(path.join(OUT, 'spike.json'), JSON.stringify(res, null, 1))
for (const s of res.steps) if (s[0] !== 'readback') console.log(s[0], JSON.stringify(s[1]))
if (res.readback)
  for (const r of res.readback)
    console.log('readback layer', r.layer, r.readStatus, 'centre', r.centre, 'corner', r.corner)
// write each eye's 64x64 thumbnail as a PPM (bottom-up rows flipped)
if (res.readback)
  for (const r of res.readback) {
    const N = 64
    const rows = []
    for (let y = N - 1; y >= 0; y--) for (let x = 0; x < N; x++) rows.push(...r.thumb[y * N + x])
    fs.writeFileSync(
      path.join(OUT, `eye${r.layer}.ppm`),
      Buffer.concat([Buffer.from(`P6 ${N} ${N} 255\n`), Buffer.from(rows)]),
    )
  }
await page.screenshot({ path: path.join(OUT, 'page.png') })
await ctx.close()
console.log('DONE', res.done === true)
