import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['electron/tests/**/*.spec.ts', 'scripts/tests/**/*.spec.mjs'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['electron/*.ts'],
      // main.ts is window/tray glue that needs a real Electron runtime; the
      // pwsh-exemption precedent applies — it is covered by the manual matrix
      // in README plus CI typecheck instead of unit thresholds.
      exclude: ['electron/main.ts'],
      thresholds: {
        // Real subprocesses and real HTTP cover these files end to end; the
        // remaining branch gap is the posix-only killTree path on Windows
        // (and vice versa), hence branches at 90.
        'electron/sidecar.ts': { statements: 100, functions: 100, lines: 100, branches: 90 },
        'electron/updater.ts': { statements: 100, functions: 100, lines: 100, branches: 100 },
        'electron/helpers.ts': { statements: 100, functions: 100, lines: 100, branches: 100 },
      },
    },
  },
})
