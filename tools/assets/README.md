# `tools/assets/` — the content pipeline, such as it is

Deliberately thin. **Publishing is two plain rclone commands in `package.json`**
(`assets:pull` / `assets:push`) and there is no wrapper around them, because two
lines of rclone a human can read and re-run by hand beat a Node wrapper that has
to be debugged at the exact moment content is broken.

What is here is the part rclone cannot do: knowing what *should* be there.

| File | What it is |
| --- | --- |
| `required-assets.json` | The machine-readable manifest — one row per asset: bucket path, state, size, licence classification, provenance. Prose half is `content/MANIFEST.md`. |
| `check-assets-present.mjs` | Lints that manifest, verifies the hydrated content tree matches it, and reports what is still unpublished. Zero dependencies, no network, no credentials. |

| `content-pack-lib.mjs`, `build-content-pack.mjs`, `pull-content-pack.mjs` | The redistributable content pack. Every manifest row has a `share` field: an SPDX id (`CC-BY-NC-4.0`, `CC0-1.0`, `CC-BY-SA-4.0`) or `none`. Bought Asset Store assets, Unity content and the mascot are always `none`. `pnpm content:pack` zips only the shared rows (sha-verified) into the gitignored `content-pack/`; `pnpm content:pull` downloads the pack from a GitHub Release (or `--from <zip>`), verifies every sha and unpacks into `public/`. It never uploads. `check-assets-present.mjs --pack` verifies a pack-only tree. |

```bash
node tools/assets/check-assets-present.mjs --pack       # a tree from `pnpm content:pull`: shared assets only
node tools/assets/check-assets-present.mjs              # lint + verify `ready` assets
node tools/assets/check-assets-present.mjs --staged     # also confirm staged bytes exist
node tools/assets/check-assets-present.mjs --verify-hashes
node tools/assets/check-assets-present.mjs --json       # for CI

# env: ASSET_DIR (default public/) · FF2_STAGE_DIR · FF2_ASSET_MANIFEST
```

Exit 0 = fine, 1 = something is missing or malformed, 2 = bad invocation.

Run it **after** hydration and again **after** a build, so a bundle that would
ship an empty content tree fails the job instead of deploying. The one rule it
enforces that is not about bytes: an asset classified `licence: REPLACE` may
never be `state: ready`. Uploading to the public content bucket is publishing,
and a bake of bought geometry cannot be published from there any more than it
can be committed here.

Background: `docs/asset-storage.md` (storage model, Cloudflare runbook, CORS)
and `content/MANIFEST.md` (what the first mission needs, and why).
