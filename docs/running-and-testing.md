# Running and testing

## Setup

```sh
pnpm install            # also installs the git hooks (the "prepare" script)
pnpm content:pull       # fetch the open content pack into public/assets/
pnpm e2e:install        # once, if you will run the browser tests: installs Chromium
```

Node 22 or newer, pnpm 10. `.nvmrc` names the Node version the project is developed on.

## Running the game

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server over HTTPS on all interfaces (a basic self-signed certificate). WebXR needs a secure context |
| `pnpm build` | Type-checks, then makes a production build in `dist/` |
| `pnpm preview` | Serves `dist/`. Prefer it over `pnpm dev` when you are judging performance in a headset: a dev build is not a measurement |

**In a headset**, open the `Network:` URL Vite prints in the headset's browser and accept the
certificate once. **On a desktop**, the game runs on the keyboard, a gamepad or the mouse; the
URL switch `?xr=off` skips the check for an immersive-VR runtime, which on some machines starts
the VR runtime just to ask.

Useful URL switches while developing: `?mission=<id>` starts a mission directly; `?perf=1` shows
a frame-time overlay and exposes a capture handle; `?lookdev=1` opens a panel for tuning the
look.

## The tiers of tests

Two layers, each with tiers, so that the quick loop is quick and the careful one is available.

### Unit tests (Vitest, node)

| Command | What runs | When |
|---|---|---|
| `pnpm test:smoke` | A handful of wide tests that fly all thirteen missions through the same per-step calls the game makes. A few seconds. If one fails, the runner automatically runs the narrower tests that share its modules and prints them narrowest first | While you work |
| `pnpm check` | `typecheck` + `lint` + every unit test | Before you send a change |
| `pnpm check:fast` | `typecheck` + `lint` + the smoke tier | A quicker inner loop |
| `pnpm test:related <file>` | Vitest's "which tests import this module" | To find the tests for one file |
| `pnpm test:coverage`, `pnpm bench` | Coverage; micro-benchmarks | By hand |

The unit tests need no browser and no GPU. They include tests that fly every mission with the
autopilot, check that the simulation stays pure, check generated data against its recorded
hashes, run the lap server's handlers against a real SQLite database, and run the rooms server
class against a fake room. Many assert **relationships rather than values** (a distance, a ratio,
that two paths agree with something outside the code), because a test that re-derives its
expectation the way the code does has not tested the code.

### Browser tests (Playwright)

The end-to-end specs drive the real game in a real browser.

| Command | What runs |
|---|---|
| `pnpm e2e` | Every **behavior** spec: it presses or drives something and asserts what the game did |
| `pnpm e2e:changed` | The behavior specs a diff can reach (by import graph) plus a small smoke set |
| `pnpm e2e:smoke` | Three tests: boot, a menu walk, a mission to the leaderboard |
| `pnpm e2e:measure` | Only the **measure** specs |
| `pnpm e2e:all` | Behavior and measure together: the full gate before a release |
| `pnpm e2e:shaders` | The shader link check (below) |

**Behavior or measure.** Every spec is one or the other. A *measure* spec is a measurement, a
census, an A/B comparison, a photograph taken to make a look call, or a one-question
investigation; it is tagged `@measure` in its `describe` title and skipped by default. Naming a
measure spec on the command line runs it (for example `pnpm exec playwright test perf-fill`), so a
named spec can never silently collect zero tests.

**Headless and headed.** Behavior specs run headless on the real GPU when system Chrome is
available. Bundled Chromium headless falls back to software rendering at about one frame per
second, so with no system browser the specs run headed. Measure specs always run headed.
`E2E_HEADLESS=0` or `1` overrides; `E2E_CHANNEL=msedge` uses Edge. Run your own dev server on your
own port (`E2E_PORT`, default 5273) so that two sessions do not share one.

**Do not edit `src/` while browser tests run.** Vite reloads the page under the test.

**The content pack must be in place** (`pnpm content:pull`) or the specs will fail at boot for
lack of assets. Specs written against the full live game may notice props or hangar pieces
that the open pack does not hold.

## The shader link check

`pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` can all pass while a shader program
fails to link: a uniform declared in the fragment prelude and used in the vertex shader, say.
Nothing but a GPU can tell. After any shader change:

1. Load the game and read the console.
2. Run `pnpm e2e:shaders`. It asks GL for `LINK_STATUS` on every program three.js holds,
   including ones the warm-up compiled and nothing drew, and it first asserts that draw calls
   and programs are non-zero, so a frame that drew nothing cannot pass by reporting no errors.

A successfully linked program can still log a `Program Info Log` for benign precision warnings,
so do not match on the word "shader" alone.

## Performance

The gate for performance is a worn capture in a headset, not a unit test: are frames inside
budget, and does the quality scaler step down when they are not? `?perf=1` records the frame
timings. Two warnings if you take measurements:

- **The game measures itself and acts on the answer.** Heavy work on the same machine (a test
  run, a build) starves the frame, and the quality scaler then drops resolution, so you end up
  measuring a reconfigured game. Run nothing else while a measurement runs.
- Use a production build (`pnpm build && pnpm preview`), not `pnpm dev`.

## Other checks

| Command | What it checks |
|---|---|
| `pnpm extract:check` | The generated constants and content trees match their recorded hashes |
| `pnpm assets:check` | The files on disk under `public/assets/` are the bytes the manifest records (hash, not just presence) |
| `pnpm audit:security` | Scans the tree for credential shapes and secret-named files |
| `node .githooks/check-denylist.mjs --list-rules` | What the commit hook refuses (binaries, purchased asset names) and why |
| `pnpm typecheck:rooms` | The rooms Worker against the Workers types (run `pnpm --dir workers/rooms install` first) |

## Platform notes

CI runs on Linux; many contributors will be on Windows or macOS. Anything involving file paths,
letter case, line endings or spawning processes can pass on one and fail on the other. If you add
a test that reads a file or shells out, think about the other platform before you push.
