// src/boot/eye-buffer-pin.ts: the eye buffer's three URL pins. DEV-997.
//
//   ?eyeBuffer=1     draw a headset session through the app-owned eye buffer
//                    (`render/eye-buffer.ts`); the controller moves its scale
//   ?eyeScale=0.8    pin the scale instead, for an A/B (needs ?eyeBuffer=1)
//   ?eyeMsaa=0|2|4   the eye buffer's samples (needs ?eyeBuffer=1); absent, what
//                    three would have given the layer (4 on an antialiased
//                    context, else 0)
//
// A leaf (its one import is the pure `render/eye-scale.ts`) so a spec can
// import the shipped default.
// Same spellings as `?multiview=` for the switch, because these are typed into
// a headset's address bar by hand.

import { EYE_SCALE_CEILING, EYE_SCALE_PIN_MIN } from '../render/eye-scale'

/** The default, absent the pin. OFF: turning it on is Matt's call after a worn session. */
export const EYE_BUFFER_SHIPPED = false

/** `?eyeScale=`'s range: below the floor a pin is a typo, above 1 the layer has no more pixels. */
export const EYE_SCALE_PIN_RANGE = { min: EYE_SCALE_PIN_MIN, max: EYE_SCALE_CEILING } as const

/** `?eyeBuffer=1|0`. Absence, or anything else (with a warning), is the shipped default. */
export const parseEyeBufferPin = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): boolean => {
  if (raw === null) return EYE_BUFFER_SHIPPED
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === '') return true
  if (raw === '0' || raw === 'off' || raw === 'false') return false
  warn(`?eyeBuffer=${raw} is not 0 or 1; ignored`)
  return EYE_BUFFER_SHIPPED
}

/** `?eyeScale=<s>`: a number in the range, or null (the controller decides) with a warning. */
export const parseEyeScalePin = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): number | null => {
  if (raw === null || raw === '') return null
  const value = Number(raw)
  if (
    Number.isFinite(value) &&
    value >= EYE_SCALE_PIN_RANGE.min &&
    value <= EYE_SCALE_PIN_RANGE.max
  ) {
    return value
  }
  warn(
    `?eyeScale=${raw} is not a number in [${EYE_SCALE_PIN_RANGE.min}, ${EYE_SCALE_PIN_RANGE.max}]; ` +
      'the controller decides',
  )
  return null
}

/** `?eyeMsaa=0|2|4`, or null for the default, with a warning for anything else. */
export const parseEyeMsaaPin = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): 0 | 2 | 4 | null => {
  if (raw === null || raw === '') return null
  if (raw === '0' || raw === '2' || raw === '4') return Number(raw) as 0 | 2 | 4
  warn(`?eyeMsaa=${raw} is not 0, 2 or 4; the default`)
  return null
}

/** What the three pins add up to. Null: nothing installed. */
export interface EyeBufferPin {
  readonly scale: number | null
  readonly msaa: 0 | 2 | 4 | null
}

/**
 * All three, from a query string. `?eyeScale=` or `?eyeMsaa=` without the
 * switch warns and installs nothing: a pin that silently did nothing would
 * read as an A/B arm that measured the default.
 */
export const parseEyeBufferPins = (
  params: { get(name: string): string | null },
  warn: (message: string) => void = () => {},
): EyeBufferPin | null => {
  const on = parseEyeBufferPin(params.get('eyeBuffer'), warn)
  const scale = parseEyeScalePin(params.get('eyeScale'), warn)
  const msaa = parseEyeMsaaPin(params.get('eyeMsaa'), warn)
  if (!on) {
    if (params.get('eyeScale') !== null || params.get('eyeMsaa') !== null) {
      warn('?eyeScale= and ?eyeMsaa= need ?eyeBuffer=1; ignored')
    }
    return null
  }
  return { scale, msaa }
}
