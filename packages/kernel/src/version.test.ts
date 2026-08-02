import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEEL_VERSION } from "./version.js";

// The single source of truth for the version string must survive `bun --compile` (where
// `package.json` is not on disk — Epic 1.10 ADR-0009). `version.ts` is that source; this drift
// guard fails the build if it falls out of sync with the package manifest.
describe("KEEL_VERSION", () => {
  it("is a non-empty semver-ish string", () => {
    expect(KEEL_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
  });

  it("matches the kernel package.json version (no drift)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version: string;
    };
    expect(KEEL_VERSION).toBe(pkg.version);
  });

  it("is the current public pre-alpha version across every private workspace manifest", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..");
    const manifests = [
      "package.json",
      "packages/eval/package.json",
      "packages/kernel/package.json",
      "packages/memory/package.json",
      "packages/shared/package.json",
      "packages/simulator/package.json",
      "packages/warden/package.json",
    ];

    expect(KEEL_VERSION).toBe("0.1.1");
    for (const path of manifests) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as {
        private?: boolean;
        version?: string;
      };
      expect(manifest.version, path).toBe(KEEL_VERSION);
      expect(manifest.private, path).toBe(true);
    }
  });
});
