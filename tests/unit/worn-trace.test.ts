// tests/unit/worn-trace.test.ts: the parts of the worn-trace tool that do not need a headset or a
// browser, and the streaming reader that lets a gigabyte trace be reduced. DEV-993.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { keepEvent, loadTraceFile, scanTraceObjects } from '../../tools/perf/trace-frame.mjs'
import {
  DEFAULT_URL,
  grantPreferences,
  parseArgs,
  withTraceParam,
  wornCategories,
} from '../../tools/perf/worn-trace.mjs'

describe('worn-trace arguments (DEV-993)', () => {
  it('defaults to the preview build with the perf surface on', () => {
    const o = parseArgs([])
    expect(o.url).toBe(DEFAULT_URL)
    expect(new URL(o.url).searchParams.get('perf')).toBe('1')
    expect(o.seconds).toBe(180)
    expect(o.auto).toBeNull()
  })

  it('takes a localhost URL, a hard timeout and an output folder, and skips a pnpm `--`', () => {
    const o = parseArgs(['--', 'https://localhost:5173/?perf=1', '--seconds', '90', '--out', 'x'])
    expect(o.url).toBe('https://localhost:5173/?perf=1')
    expect(o.seconds).toBe(90)
    expect(o.out).toBe('x')
  })

  it('refuses an option it does not know rather than ignoring it', () => {
    expect(() => parseArgs(['--secnods', '5'])).toThrow(/unknown option/)
    expect(() => parseArgs(['--seconds', '0'])).toThrow(/positive/)
  })

  it('arms the game recorder with the hard timeout unless the URL already chose one', () => {
    expect(new URL(withTraceParam('https://a.test/?perf=1', 180)).searchParams.get('trace')).toBe(
      '180',
    )
    expect(
      new URL(withTraceParam('https://a.test/?perf=1&trace=45', 180)).searchParams.get('trace'),
    ).toBe('45')
  })

  it('pre-grants the vr content setting for exactly the page origin', () => {
    const p = grantPreferences('https://main.ff-10yr.pages.dev')
    expect(p.profile.content_settings.exceptions.vr).toEqual({
      'https://main.ff-10yr.pages.dev,*': { setting: 1 },
    })
  })

  it('asks for the GPU process, the compositor and XR, and leaves v8 out', () => {
    const c = wornCategories(false)
    for (const need of ['gpu', 'gpu.service', 'viz', 'xr', 'toplevel', 'devtools.timeline'])
      expect(c).toContain(need)
    expect(c).not.toContain('v8')
    expect(wornCategories(true)).not.toContain('cc')
  })
})

describe('streaming trace reader (DEV-993)', () => {
  const writeTrace = (events: unknown[], tail = ',"metadata":{"a":[1,2]}') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-worn-test-'))
    const file = path.join(dir, 't.json')
    fs.writeFileSync(
      file,
      `{"traceEvents":[${events.map((e) => JSON.stringify(e)).join(',')}]${tail}}`,
    )
    return { dir, file }
  }

  it('returns every element exactly once at any chunk size, through braces, quotes and multibyte text', async () => {
    const events = [
      { ph: 'X', name: 'a}{"b', args: { s: 'quote " and \\ and } { ] [', u: 'é€😀' } },
      { ph: 'M', name: 'process_name', pid: 1, args: { name: 'GPU Process' } },
      { ph: 'X', name: 'c', args: { nested: { deep: [1, { x: 2 }] } } },
    ]
    const { dir, file } = writeTrace(events)
    try {
      for (const chunk of [1, 2, 3, 7, 64, 1 << 20]) {
        const seen: unknown[] = []
        await scanTraceObjects(file, (t) => seen.push(JSON.parse(t)), chunk)
        expect(seen, `chunk ${chunk}`).toEqual(events)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops at the end of the array and does not read the metadata as events', async () => {
    const { dir, file } = writeTrace([{ ph: 'X', name: 'only' }])
    try {
      const seen: unknown[] = []
      await scanTraceObjects(file, (t) => seen.push(JSON.parse(t)), 5)
      expect(seen).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps what the reducer reads, the GPU main thread tasks, and drops the rest', async () => {
    const events = [
      { ph: 'M', name: 'process_name', pid: 9, args: { name: 'GPU Process' } },
      {
        ph: 'X',
        name: 'CommandBufferStub::OnAsyncFlush',
        pid: 9,
        tid: 2,
        ts: 1,
        dur: 5,
        args: { put_offset: 1 },
      },
      { ph: 'X', name: 'HeldIt', pid: 9, tid: 2, ts: 2, dur: 500 },
      { ph: 'X', name: 'TinyOnGpuMain', pid: 9, tid: 2, ts: 3, dur: 5 },
      { ph: 'X', name: 'LongOnOtherThread', pid: 9, tid: 3, ts: 4, dur: 500 },
      { ph: 'X', name: 'xrWaitFrame', pid: 4, tid: 1, ts: 5, dur: 9, cat: 'xr' },
      { ph: 'X', name: 'Paint', pid: 5, tid: 1, ts: 6, dur: 900, cat: 'devtools.timeline' },
    ]
    const { dir, file } = writeTrace(events)
    try {
      const kept = (await loadTraceFile(file)) as { name: string }[]
      expect(kept.map((e) => e.name)).toEqual([
        'process_name',
        'CommandBufferStub::OnAsyncFlush',
        'HeldIt',
        'xrWaitFrame',
      ])
      expect(keepEvent({ ph: 'X', name: 'Paint', pid: 5, tid: 1, dur: 900 }, 9, 2)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
