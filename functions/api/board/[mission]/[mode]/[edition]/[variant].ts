// functions/api/board/[mission]/[mode]/[edition]/[variant].ts — a board, fastest first. DEV-372.
//
//   GET /api/board/<mission>/<mode>/<edition>/<variant>[?limit=N]
//
// One board per aircraft variant (DEV-380): `standard`, and on Anniversary any
// other variant the aircraft file lists. The CURRENT rules version's board
// only (`content/lap-courses.json`): a lap posted under older rules stays
// raceable from its link and is on no board.

import { getBoard, type LapEnv } from '../../../../../../src/net/lap-server'
import type { PagesFunction } from '../../../../../../src/net/pages-function'

const one = (v: string | string[]): string => (Array.isArray(v) ? (v[0] ?? '') : v)

export const onRequestGet: PagesFunction<LapEnv, 'mission' | 'mode' | 'edition' | 'variant'> = ({
  request,
  env,
  params,
}) =>
  getBoard(
    {
      mission: one(params.mission),
      mode: one(params.mode),
      edition: one(params.edition),
      variant: one(params.variant),
    },
    request,
    env,
  )
