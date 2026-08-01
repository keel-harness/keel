import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Vite 6 separates client and SSR condition lists. Keep both Node test paths on
// workspace source while avoiding the generic `module` condition: some external
// packages publish an ESM-shaped `module` export without declaring ESM to Node.
const nodeSourceConditions = ["@keel/source", "node", "development|production"];

export default defineConfig({
  // Resolve cross-package "@keel/*" imports to TypeScript source via the
  // "@keel/source" export condition (mirrors `customConditions` in
  // tsconfig.base.json), so tests, typecheck, and the IDE all work without a
  // build step. The base conditions (import/node/default) still apply, so
  // external deps (zod, etc.) resolve normally.
  resolve: {
    conditions: nodeSourceConditions,
  },
  ssr: {
    resolve: {
      conditions: nodeSourceConditions,
    },
  },
  // Ink render components are .tsx with the React automatic JSX runtime (ADR-0003).
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    environment: "node",
    // Fail the run (CI only) on a committed focused `.only` — a stray `.only` otherwise passes
    // CI green while silently skipping its siblings (a "hidden green"). Gated on CI so `.only`
    // stays usable for local iteration (`pnpm test` unaffected). dev-harness hardening, 2026-06-25.
    forbidOnly: !!process.env.CI,
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
      "packaging/**/*.test.ts",
      "vendor/sandbox-runtime/test/sandbox/linux-proxy-readiness.test.ts",
    ],
    // Pin the fast-check global seed (replayable failures) — see ADR-0020 / I6.
    setupFiles: ["./vitest.setup.ts"],
    pool: "forks",
    // Several contract/security tests exercise real child processes with intentionally bounded
    // wall-clock handshakes (for example ADR-0078's exact 250 ms presentation barrier). Leave one
    // scheduler slot available to those children instead of letting Vitest saturate every reported
    // CPU and turning valid product timeouts into load-dependent test flakes.
    maxWorkers: Math.max(1, availableParallelism() - 1),
    // Property-based tests generate hundreds of values per run; under v8 coverage
    // instrumentation the recursive-schema generators (e.g. SimulatorScript's
    // JsonObject args via fc.jsonValue) measured ~5.3s — over vitest's 5s default,
    // a real CI timeout. 20s gives comfortable headroom; the pinned seed above
    // makes the duration deterministic (no occasional pathological case).
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportOnFailure: true,
      // Measure EVERY package's source by default, so a newly added package is
      // coverage-gated automatically (no silent ungating). Packages that have no
      // real code yet are listed in `exclude` below; when a package gains tested
      // source, remove its entry and it is immediately held to the global
      // threshold. Adding a brand-new package requires no config change to be
      // gated — it is covered by the glob.
      include: [
        "packages/*/src/**",
        "packaging/process-group-cleanup.mjs",
        "packaging/process-group-controller.mjs",
      ],
      // The `keel` bin is an argv→stdout entry wrapper (logic lives in tested runKeelCli);
      // it is smoke-tested as a built binary in Epic 1.10, not unit-tested here.
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "packages/kernel/src/cli/bin.ts",
        "packages/warden/src/bin.ts",
        // Ink render components (ADR-0003): thin maps over the ViewModel, exempt from line/branch
        // thresholds and covered by ink-testing-library frame snapshots instead. All branching
        // logic lives in the (gated) reducer/headless/diff.
        "packages/kernel/src/tui/ink/**",
        "packages/memory/src/**",
      ],
      thresholds: {
        // perFile so a single 0%-covered file can no longer hide behind the
        // aggregate (closes C4 — see ADR-0020). EVERY included file must clear
        // the floor individually.
        perFile: true,
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
        // Per-package floors (MASTER_SPEC §6.1) are added only when stricter than the global 90;
        // kernel (§6.1 ≥85) and memory (§6.1 ≥90) need no override. Warden's live coverage gate is
        // 95 for lines/functions/statements and 90 for branches; only its argv wrapper is excluded.
        // See ADR-0020.
        "packages/warden/src/**": { lines: 95, functions: 95, statements: 95, branches: 90 },
      },
    },
  },
});
