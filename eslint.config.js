// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import {
  kernelWardenRestrictedImports,
  kernelWardenTestRestrictedImports,
} from "./tools/eslint/kernel-warden-boundary.mjs";

export default tseslint.config(
  // eval/mini is a manual live-eval harness: a Node runner script + intentionally-imperfect task
  // fixtures (buggy/stub code the agent must fix). Not gated product code — packages/ is.
  // packaging/ is the bun-only build script (Epic 1.10 / ADR-0009): it runs under Bun (Bun globals,
  // cross-package .ts imports), not the Node/tsc dev toolchain, so it sits outside the type-aware
  // lint program — validated by running it (locally + the CI `package` job), not by tsc.
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "eval/mini/**",
      "eval/harbor-adapter/**", // the Python TB-2.1 adapter (its own toolchain) + gitignored local run artifacts (.venv/, run-matrix.*, matrix-out/) — no tracked TS/JS here for eslint to cover
      "docs/research/policy-engine-spike/**", // isolated ADR-0004 spike (own package.json; run under node/bun, not the workspace tsconfig) — validated by running it, not by root lint
      ".claude/**", // gitignored local agent/tooling state (worktrees, etc.) — no tracked TS/JS
      "packaging/**",
      "build/**",
      "vendor/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Test/lint configuration files live at the root and are not in any package tsconfig's
          // "include". Allow the exact reviewed files via the default project so type-aware rules
          // still run on them without admitting a broad glob.
          allowDefaultProject: [
            "vitest.config.ts",
            "vitest.setup.ts",
            "vitest.egress-product.config.ts",
            "vitest.egress-product.setup.ts",
            "eslint.config.js",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // I7: structurally catch floating/misused promises across async generators
      // (simulator stream, eval replay) and fs/promises call sites.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // async generators implementing AsyncIterable<T> interfaces (ModelPort.stream,
      // replay test mocks) yield without awaiting — that is the correct pattern:
      // the generator IS async by declaration so callers can for-await it, but the
      // body produces values synchronously.  require-await is a false positive here.
      "@typescript-eslint/require-await": "off",
    },
  },
  // ADR-0071 P1-10: structurally forbid the kernel from importing the warden's TypeScript
  // enforcement library (a Phase-4 Rust warden port would strand such imports). PRODUCTION
  // kernel code may import only the sanctioned warden-host entry + documented residuals; tests
  // may additionally reach the warden for fixtures. Single source of truth:
  // tools/eslint/kernel-warden-boundary.mjs (shared with the kernel boundary test).
  {
    files: ["packages/kernel/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": kernelWardenRestrictedImports,
    },
  },
  {
    files: ["packages/kernel/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": kernelWardenTestRestrictedImports,
    },
  },
  // JS/config files cannot be type-checked (no TS program for them). Disable
  // all type-aware rules for plain JS and compiled-output files.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
