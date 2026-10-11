// tests/unit/helpers/checkout.ts: which kind of checkout these tests are running in.
//
// The same suite runs in two trees. The private working repository has the planning and
// history documents, the export tooling and (after `pnpm assets:pull`) the bought assets the
// live game uses. The public `facetedflight` repository is an export of it
// (tools/release/export-public.mjs) that has none of those, by design
// (plan/PUBLIC-REPO-facetedflight.md §1.6, §4.3).
//
// A test whose input is one of those things skips where the input is absent, and its loud
// counterpart (CLAUDE.md: `describe.skipIf` skips the TESTS, so a guarded suite needs one)
// asserts the input is present ONLY in the maintainer checkout, where its absence is a fault:
//
//   describe.skipIf(!HAVE)('the real tests', ...)
//   describe.skipIf(HAVE || !MAINTAINER_CHECKOUT)('the input is missing', () => {
//     it('says so', () => expect(HAVE).toBe(true))
//   })
//
// The marker is a file the export leaves out by rule (copy-list's `facetedflight` profile puts
// `tools/release/` OUT), so it is a fact about the tree, not a switch anyone sets. Nothing in
// `src/` reads it: the game runs the same in both trees. And this is not circular in the one
// place it could rot: `tests/unit/release-profile.test.ts`, which exists only in the private
// tree, asserts that MAINTAINER_CHECKOUT is true there.
//
// A BOUGHT asset is a third case, because it is not in the private tree either: it arrives in
// `public/assets/` from R2 (`pnpm assets:pull`), and a plain `git clone` of the private repo
// never has it. That clone is exactly what the private repo's CI runner makes
// (.github/workflows/asset-denylist.yml: "a plain checkout is ALL a job here gets"), so a loud
// counterpart keyed on MAINTAINER_CHECKOUT alone was red on every private run. Its premise is
// "this tree was hydrated, so a missing GLB is a fault" (a partial pull, a conversion never
// published), and the fact that states it is the asset folder, which only a pull (or a
// worktree's junction to the main checkout's) creates. Such a counterpart keys on
// HYDRATED_MAINTAINER_CHECKOUT instead.

import fs from 'node:fs'
import path from 'node:path'
import { REPO } from './repo-root'

/** True in the private working repository; false in the public export. */
export const MAINTAINER_CHECKOUT = fs.existsSync(
  path.join(REPO, 'tools', 'release', 'copy-list.mjs'),
)

/** True when `rel` (repo-relative) exists. Cheap: one stat, safe at collection time. */
export const present = (rel: string): boolean => fs.existsSync(path.join(REPO, rel))

/**
 * True in a private checkout whose `public/assets/` has been hydrated at all. False in the
 * public export and in a plain clone of the private repo (its CI runner). See the header.
 */
export const HYDRATED_MAINTAINER_CHECKOUT =
  MAINTAINER_CHECKOUT && present(path.join('public', 'assets'))
