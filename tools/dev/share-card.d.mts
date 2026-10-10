import type { ParsedIcon } from './app-icon.mjs'

export const SHARE_STILL_ASSET: string
export const SHARE_STILL_LOCAL: string

export interface ShareCardLayout {
  readonly width: number
  readonly height: number
  readonly plate: {
    readonly y: number
    readonly fill: string
    readonly alpha: number
    readonly bar: { readonly w: number; readonly fill: string }
    readonly hairline: { readonly h: number; readonly fill: string; readonly alpha: number }
  }
  readonly emblem: { readonly x: number; readonly y: number; readonly size: number }
  readonly text: readonly {
    readonly id: string
    readonly fill: string
    readonly contours: readonly (readonly (readonly [number, number])[])[]
    readonly width: number
  }[]
}

export interface RawImage {
  readonly width: number
  readonly height: number
  readonly channels: number
  readonly data: Uint8Array
}

export function composeShareCard(
  still: RawImage,
  icon: ParsedIcon,
  layout: ShareCardLayout,
): Uint8Array
export function shareCardFromStill(stillPng: Buffer, svg: string, layout: ShareCardLayout): Buffer
export function readLayout(path: string): ShareCardLayout
export function loadStill(options: {
  root: string
  env?: Record<string, string | undefined>
  fetchImpl?: (url: string) => Promise<Response>
}): Promise<{ bytes: Buffer | null; from: string; why?: string }>
