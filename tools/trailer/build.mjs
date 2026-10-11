// tools/trailer/build.mjs: renders a trailer from an edit list. From the repo root:
//
//   node tools/trailer/build.mjs [tools/trailer/edl.json] [--draft]
//
// Clips come from capture.spec.ts, in $TRAILER_WORK/clips (default
// docs/private/trailer, gitignored), and the result is $TRAILER_WORK/out/.
// A virtual-time clip is one GAME frame per image, re-timed here to exactly
// 60 fps, so a shot's `in` is seconds of game time from the clip's start.
// tools/trailer/README.md is the manual, edl.json's fields included.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const here = process.env.TRAILER_WORK ?? 'docs/private/trailer'
const edlPath = process.argv.find((a) => a.endsWith('.json')) ?? 'tools/trailer/edl.json'
const draft = process.argv.includes('--draft')
const edl = JSON.parse(fs.readFileSync(edlPath, 'utf8'))
const W = 1920
const H = 1080
const FPS = 60
const segDir = path.join(here, 'out', 'segs')
fs.rmSync(segDir, { recursive: true, force: true })
fs.mkdirSync(segDir, { recursive: true })

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' })
const enc = draft
  ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']
  : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '12']

/** ffmpeg input args + the filter that turns that clip into 60 fps, starting at game second 0. */
const source = (clip) => {
  const list = path.join(here, 'clips', clip, 'list.txt')
  if (fs.existsSync(list))
    return {
      args: ['-f', 'concat', '-safe', '0', '-i', list],
      retime: `fps=${FPS},setpts=N/${FPS}/TB`,
    }
  const mp4 = path.join(here, 'clips', `${clip}.mp4`)
  if (fs.existsSync(mp4)) return { args: ['-i', mp4], retime: `setpts=N/${FPS}/TB` }
  throw new Error(`no clip ${clip}`)
}

const look = (s) => [
  `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
  ...(s.grade ? [s.grade] : []),
  `format=yuv420p`,
]

// 1. Each segment to its own file, exactly `dur` seconds at 60 fps.
const segs = []
edl.shots.forEach((s, i) => {
  const out = path.join(segDir, `${String(i).padStart(2, '0')}-${s.clip}.mp4`)
  segs.push({ ...s, out })
  const a = source(s.clip)
  const speed = s.speed ?? 1
  const chain = (src, at) =>
    `${src.retime},trim=start=${at}:duration=${s.dur * speed},setpts=(PTS-STARTPTS)/${speed}${s.reverse ? ',reverse' : ''}`
  if (s.wipeFrom) {
    // A wipe: `wipeFrom` plays first, `clip` replaces it across `wipe` seconds
    // ending at `wipeAt`, both clips at the SAME game time (matched footage).
    const b = source(s.wipeFrom)
    const w = s.wipe ?? 1
    const f = [
      `[0:v]${chain(b, s.in)},${look(s).join(',')}[a]`,
      `[1:v]${a.retime},trim=start=${s.in + s.wipeAt - w}:duration=${s.dur - s.wipeAt + w},setpts=PTS-STARTPTS,${look(s).join(',')}[b]`,
      `[a][b]xfade=transition=${s.transition ?? 'wiperight'}:duration=${w}:offset=${s.wipeAt - w},trim=duration=${s.dur}[v]`,
    ]
    ff([
      ...b.args,
      ...a.args,
      '-filter_complex',
      f.join(';'),
      '-map',
      '[v]',
      '-r',
      String(FPS),
      ...enc,
      '-an',
      out,
    ])
  } else {
    ff([
      ...a.args,
      '-filter_complex',
      `[0:v]${chain(a, s.in)},${look(s).join(',')}[v]`,
      '-map',
      '[v]',
      '-r',
      String(FPS),
      ...enc,
      '-an',
      out,
    ])
  }
  console.log(`seg ${i} ${s.clip} ${s.dur}s`)
})

// 2. Concatenate, cross-dissolving where a shot asks for it.
let total = 0
const inputs = segs.flatMap((s) => ['-i', s.out])
const parts = []
let prev = '[0:v]'
total = segs[0].dur
for (let i = 1; i < segs.length; i++) {
  const d = segs[i].dissolve ?? 0
  const label = `[c${i}]`
  if (d > 0) {
    parts.push(`${prev}[${i}:v]xfade=transition=fade:duration=${d}:offset=${total - d}${label}`)
    total += segs[i].dur - d
  } else {
    parts.push(`${prev}[${i}:v]concat=n=2:v=1:a=0${label}`)
    total += segs[i].dur
  }
  prev = label
}

// 2b. Image overlays (the logo bug): looped stills, faded, placed in pixels.
const overlays = edl.overlays ?? []
const overlayInputs = overlays.flatMap((o) => [
  '-loop',
  '1',
  '-t',
  String(edl.length ?? total),
  '-i',
  o.file,
])
overlays.forEach((o, k) => {
  const f = o.fade ?? 0.5
  const idx = segs.length + k
  parts.push(
    `[${idx}:v]format=rgba,scale=${o.w}:-1,colorchannelmixer=aa=${o.opacity ?? 1},fade=t=in:st=${o.at}:d=${f}:alpha=1,fade=t=out:st=${o.to - f}:d=${f}:alpha=1[ov${k}]`,
  )
  parts.push(`${prev}[ov${k}]overlay=x=${o.x}:y=${o.y}:enable='between(t,${o.at},${o.to})'[o${k}]`)
  prev = `[o${k}]`
})

// 3. Cards: CRYSTAL, the game's UI face, fading in and out.
const font = 'public/assets/fonts/crystal-regular.ttf'
const esc = (t) =>
  t.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019').replace(/%/g, '\\%')
const cards = (edl.cards ?? []).map((c) => {
  const f = c.fade ?? 0.4
  const alpha = `if(lt(t,${c.at}),0,if(lt(t,${c.at + f}),(t-${c.at})/${f},if(lt(t,${c.to - f}),1,if(lt(t,${c.to}),(${c.to}-t)/${f},0))))`
  const size = c.size ?? 72
  const y = c.y ?? `h*0.78-text_h/2`
  return `drawtext=fontfile='${font}':text='${esc(c.text)}':fontsize=${size}:fontcolor=${c.color ?? 'white'}:alpha='${alpha}':x=(w-text_w)/2:y=${y}:borderw=2:bordercolor=black@0.35:shadowcolor=black@0.55:shadowx=0:shadowy=3:enable='between(t,${c.at},${c.to})'`
})
const fadeIn = edl.fadeIn ?? 0
const fadeOut = edl.fadeOut ?? 1.5
const post = [
  ...cards,
  ...(fadeIn ? [`fade=t=in:st=0:d=${fadeIn}`] : []),
  `fade=t=out:st=${(edl.length ?? total) - fadeOut}:d=${fadeOut}`,
  `trim=duration=${edl.length ?? total}`,
  'format=yuv420p',
]
parts.push(`${prev}${post.join(',')}[v]`)

// 4. Music: a list of [from, to] source ranges, crossfaded 60 ms at each splice.
const m = edl.music
const musicIdx = segs.length + overlays.length
const mparts = []
m.ranges.forEach(([a, b], i) => {
  mparts.push(
    `[${musicIdx}:a]atrim=${a}:${b + (i < m.ranges.length - 1 ? 0.06 : 0)},asetpts=PTS-STARTPTS[m${i}]`,
  )
})
let mprev = '[m0]'
for (let i = 1; i < m.ranges.length; i++) {
  mparts.push(`${mprev}[m${i}]acrossfade=d=0.06:c1=tri:c2=tri[mx${i}]`)
  mprev = `[mx${i}]`
}
const len = edl.length ?? total
mparts.push(
  `${mprev}afade=t=out:st=${len - (m.fadeOut ?? 3)}:d=${m.fadeOut ?? 3},atrim=0:${len},volume=${m.gain ?? 1}[a]`,
)
// One `-i` per music range would be tidier; atrim on a split is simpler.
const split =
  m.ranges.length > 1
    ? `[${musicIdx}:a]asplit=${m.ranges.length}${m.ranges.map((_, i) => `[s${i}]`).join('')};`
    : ''
// Rewrite each range's input label to its own split output.
let k = 0
const mfinal = split
  ? mparts.map((p) =>
      p.startsWith(`[${musicIdx}:a]`) ? p.replace(`[${musicIdx}:a]`, `[s${k++}]`) : p,
    )
  : mparts
const out = path.join(here, 'out', draft ? 'trailer-draft.mp4' : 'trailer.mp4')
ff([
  ...inputs,
  ...overlayInputs,
  '-i',
  m.file,
  '-filter_complex',
  `${parts.join(';')};${split}${mfinal.join(';')}`,
  '-map',
  '[v]',
  '-map',
  '[a]',
  '-r',
  String(FPS),
  ...enc,
  '-c:a',
  'aac',
  '-b:a',
  '256k',
  '-movflags',
  '+faststart',
  out,
])
console.log(`wrote ${out} (${len.toFixed(2)} s)`)
