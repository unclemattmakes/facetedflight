// tests/unit/room-lap-size.test.ts: the room judge's body cap on a stream that
// will not cancel cleanly. DEV-675.
//
// `judgeRoomLap` refuses a body past `LAP_BODY_MAX` WHILE reading it, and stops
// the stream with `reader.cancel()`. A cancel can reject (the source's own
// `cancel` throws, or the connection is already gone), and until DEV-675 that
// rejection left the handler as an unhandled rejection: a 500 on the one path
// a cap exists to make cheap. `lap-server.ts` swallowed it from the start; the
// room's copy had drifted. The test is the premise: a source whose `cancel`
// throws, a first chunk past the cap, and a 413 back.

import { describe, expect, it } from 'vitest'
import { LAP_BODY_MAX } from '@/net/lap-policy'
import { judgeRoomLap, type RoomJudgeLink } from '@/net/room-lap'

/** A body that is over the cap in its first chunk and whose cancel rejects. */
const unstoppable = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(LAP_BODY_MAX + 1))
    },
    cancel() {
      throw new Error('the source would not cancel')
    },
  })

const never: RoomJudgeLink = {
  seat: async () => {
    throw new Error('the body was refused before any seat was asked')
  },
  verdict: async () => false,
  keep: async () => {},
  lap: async () => null,
}

describe('judgeRoomLap past the body cap (DEV-675)', () => {
  it('answers 413 when the oversize stream rejects its own cancel', async () => {
    const request = new Request('https://site/api/room/abcdefghij234567/lap', {
      method: 'POST',
      body: unstoppable(),
      // A streamed request body is half-duplex by the fetch spec; node insists.
      duplex: 'half',
    } as RequestInit)
    const res = await judgeRoomLap(request, never)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'size', reason: `over ${LAP_BODY_MAX} bytes` })
  })
})
