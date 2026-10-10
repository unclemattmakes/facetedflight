import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

// `environment: 'node'` is deliberate and is the whole point of the sim/render
// split (PORT_PLAN §2.4, DECISIONS D7): the sim must be testable with no DOM,
// no canvas and no GPU, so a golden-trajectory assertion ("89.8 m/s after 20 s
// of full throttle") runs in CI in milliseconds. If a test needs a DOM, that
// test is testing the render layer and belongs in Playwright.

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    // `pnpm bench` (VR-PERF §5.9 H1), and NOTHING else. `include` above never
    // matches a `.bench.ts`, so `pnpm test` and `pnpm check` cannot collect one
    // — which is the whole arrangement: a duration belongs to a machine and
    // must not be able to turn a commit red. The benches print; the gate on the
    // same code is `tests/unit/sim-step-budget.test.ts`, which counts.
    benchmark: { include: ['tests/bench/**/*.bench.ts'] },
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.ts', 'src/main.ts'],
    },
  },
})
