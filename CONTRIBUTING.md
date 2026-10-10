# Contributing

Thanks for looking. Bug reports, fixes, new courses and questions are all welcome.

## How changes flow

This repository is a published copy of the project's working repository, updated at each
version. Because of that:

- Open issues and pull requests here as usual. They are read and discussed here.
- A pull request that is accepted is applied to the working repository by hand, with you
  credited as co-author, and arrives back here in the next update. The pull request is closed
  with a link to that update. The merge button is not used, so your commit may not appear in
  this repository's history as itself.
- Please do not rely on commit hashes here being stable across updates.

## Before you open a pull request

```sh
pnpm install
pnpm check          # typecheck + lint + unit tests
pnpm build          # if you touched anything under src/render or src/boot
pnpm e2e:changed    # if you touched boot or input
```

If you changed a shader, load the game and read the console, then run `pnpm e2e:shaders`. No
other gate compiles a shader. [docs/running-and-testing.md](docs/running-and-testing.md) has the
detail and the test tiers.

## Rules a patch has to respect

1. **`src/sim/` is pure.** It imports no three.js, touches no `document`, `window` or
   `navigator`, and calls no `Math.random()`, `Date.now()` or `performance.now()`. A test
   enforces it. If a simulation function wants a frame delta, it is not a simulation function.
2. **Generated files are not edited.** `src/generated/` and the generated trees in `content/`
   are checked against recorded hashes. Do not hand-edit them. See
   [docs/content-as-data.md](docs/content-as-data.md).
3. **No numeric literal in `src/sim/` or `src/content/` without a reason.** Tuning values come
   from the generated constants sheet.
4. **Content is data.** Adding a course, an environment or an aircraft variant should not need a
   change under `src/`. If it does, say so in the pull request, because that is a design problem
   worth discussing.
5. **No binaries and no purchased assets in git.** `.gitignore` and the hook in
   `.githooks/check-denylist.mjs` refuse models, textures, audio and archives. Do not work
   around them; [docs/assets.md](docs/assets.md) explains why.
6. **Do not make the test harness take a different code path from a player.** A test may do
   what a player does (press Escape, click the canvas). It may not add a switch that makes the
   game behave differently under test.
7. **No em-dashes** in code, comments, docs or commit messages. Use a colon, a comma,
   parentheses or a new sentence. The commit hook checks lines you add.
8. **American spelling** in text a player or reader sees.

## Style

Biome formats and lints (`pnpm lint`, `pnpm lint:fix`). TypeScript is strict. Comments say why,
not what. Match the shape of the module you are editing.

## Security

Do not open a public issue for a vulnerability, or for anything that exposes a player's data.
Use the privacy contact listed on the game's `/privacy` page, or the repository's security
policy if one is posted.

## License of contributions

By contributing you agree your code is licensed under the repository's MIT license, and your
content (level data, models, art) under CC BY-NC 4.0, as described in [NOTICE](NOTICE).
