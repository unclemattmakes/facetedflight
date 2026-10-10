import type { Plugin } from 'vite'

export const APPLE_TOUCH_ICON: string
export const APPLE_TOUCH_SIZE: number
export interface ParsedIcon {
  readonly size: number
  readonly ground: readonly [number, number, number]
  readonly shapes: readonly {
    readonly fill: readonly [number, number, number]
    readonly points: readonly (readonly [number, number])[]
  }[]
}
export function pathPoints(d: string): [number, number][]
export function parseIconSvg(svg: string): ParsedIcon
export function rasterize(icon: ParsedIcon, size: number): Uint8Array
export function encodePng(rgb: Uint8Array, width: number, height: number): Buffer
export function appleTouchIconPng(svg: string, size?: number): Buffer
export const SHARE_CARD: string
export const SHARE_CARD_WIDTH: number
export const SHARE_CARD_HEIGHT: number
export const SHARE_CARD_MARK: number
export function rasterizeCard(
  icon: ParsedIcon,
  width: number,
  height: number,
  mark: number,
): Uint8Array
export function shareCardPng(svg: string): Buffer
export function appIcon(svgPath: string, options?: { root?: string; layoutPath?: string }): Plugin
