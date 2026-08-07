import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundledLicenseSelection,
  bundledPackageManifestPaths,
  bundledThirdPartyComponentPlan,
  bundledThirdPartyArtifactStem,
  bundleGraphIncludesPath,
  builderPathLeakReasons,
  collectExternalDependencies,
  collectNpxExternalDependencies,
  collectOptionalDependencies,
  mergeExactDependencies,
  NPX_BUNDLED_RUNTIME_DEPENDENCIES,
  NPX_BUNDLED_RUNTIME_PACKAGES,
  NPX_BUNDLED_WORKSPACE_MANIFESTS,
  type PackageManifest,
} from "./dependencies.js";

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(join(process.cwd(), path), "utf8")) as PackageManifest;
}

describe("packaging dependency projection", () => {
  it("derives the complete exact npm closure from Bun metafile inputs", () => {
    expect(
      bundledPackageManifestPaths([
        "node_modules/.pnpm/ink@7.0.5/node_modules/ink/build/ink.js",
        "node_modules/.pnpm/@pondwader+socks5-server@1.0.10/node_modules/@pondwader/socks5-server/dist/index.js",
        "node_modules/.pnpm/string-width@5.1.2/node_modules/string-width/index.js",
        "node_modules/.pnpm/string-width@8.2.1/node_modules/string-width/index.js",
        "packages/kernel/src/tui/ink/app.tsx",
        "stub-empty:react-devtools-core",
      ]),
    ).toEqual([
      "node_modules/.pnpm/@pondwader+socks5-server@1.0.10/node_modules/@pondwader/socks5-server/package.json",
      "node_modules/.pnpm/ink@7.0.5/node_modules/ink/package.json",
      "node_modules/.pnpm/string-width@5.1.2/node_modules/string-width/package.json",
      "node_modules/.pnpm/string-width@8.2.1/node_modules/string-width/package.json",
    ]);
  });

  it("detects a vendored component only when its files contributed bundle bytes", () => {
    expect(
      bundleGraphIncludesPath(
        [
          "packages/kernel/src/index.ts",
          "vendor/sandbox-runtime/dist/index.js",
          "node_modules/zod/index.js",
        ],
        "vendor/sandbox-runtime",
      ),
    ).toBe(true);
    expect(
      bundleGraphIncludesPath(
        ["packages/kernel/src/index.ts", "vendor/sandbox-runtime-copy/dist/index.js"],
        "vendor/sandbox-runtime",
      ),
    ).toBe(false);
  });

  it("selects only permissive bundled licenses and makes scoped artifact names flat", () => {
    expect(bundledLicenseSelection("ink", "MIT")).toBe("MIT");
    expect(bundledLicenseSelection("typescript", "Apache-2.0")).toBe("Apache-2.0");
    expect(bundledLicenseSelection("node-forge", "(BSD-3-Clause OR GPL-2.0)")).toBe("BSD-3-Clause");
    expect(() => bundledLicenseSelection("unsafe", "GPL-3.0")).toThrow(
      "unsupported bundled license",
    );
    expect(bundledThirdPartyArtifactStem("@pondwader/socks5-server", "1.0.10")).toBe(
      "pondwader--socks5-server-1.0.10",
    );
  });

  it("plans collision-free license and notice artifacts for every graph-derived package version", () => {
    expect(
      bundledThirdPartyComponentPlan([
        {
          manifestPath: "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/package.json",
          name: "typescript",
          version: "5.9.3",
          declaredLicense: "Apache-2.0",
          licenseFiles: ["LICENSE.txt"],
          noticeFiles: ["ThirdPartyNoticeText.txt"],
          source: "npm",
        },
        {
          manifestPath:
            "node_modules/.pnpm/@pondwader+socks5-server@1.0.10/node_modules/@pondwader/socks5-server/package.json",
          name: "@pondwader/socks5-server",
          version: "1.0.10",
          declaredLicense: "MIT",
          licenseFiles: ["LICENSE"],
          noticeFiles: [],
          source: "npm",
        },
      ]),
    ).toEqual([
      {
        name: "@pondwader/socks5-server",
        version: "1.0.10",
        license: "MIT",
        source: "npm",
        manifestPath:
          "node_modules/.pnpm/@pondwader+socks5-server@1.0.10/node_modules/@pondwader/socks5-server/package.json",
        licenseFiles: [
          {
            source: "LICENSE",
            artifact: "THIRD_PARTY_LICENSES/pondwader--socks5-server-1.0.10-LICENSE",
          },
        ],
        noticeFiles: [],
      },
      {
        name: "typescript",
        version: "5.9.3",
        license: "Apache-2.0",
        source: "npm",
        manifestPath: "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/package.json",
        licenseFiles: [
          {
            source: "LICENSE.txt",
            artifact: "THIRD_PARTY_LICENSES/typescript-5.9.3-LICENSE.txt",
          },
        ],
        noticeFiles: [
          {
            source: "ThirdPartyNoticeText.txt",
            artifact: "THIRD_PARTY_LICENSES/typescript-5.9.3-ThirdPartyNoticeText.txt",
          },
        ],
      },
    ]);
  });

  it("fails closed on missing license evidence, unsupported licenses, and artifact collisions", () => {
    expect(() =>
      bundledThirdPartyComponentPlan([
        {
          manifestPath: "node_modules/unknown/package.json",
          name: "unknown",
          version: "1.0.0",
          declaredLicense: "MIT",
          licenseFiles: [],
          noticeFiles: [],
          source: "npm",
        },
      ]),
    ).toThrow("has no redistributable license file");

    expect(() =>
      bundledThirdPartyComponentPlan([
        {
          manifestPath: "node_modules/unsafe/package.json",
          name: "unsafe",
          version: "1.0.0",
          declaredLicense: "GPL-3.0",
          licenseFiles: ["LICENSE"],
          noticeFiles: [],
          source: "npm",
        },
      ]),
    ).toThrow("unsupported bundled license");

    const duplicate = {
      manifestPath: "node_modules/ink/package.json",
      name: "ink",
      version: "7.0.5",
      declaredLicense: "MIT",
      licenseFiles: ["license"],
      noticeFiles: [],
      source: "npm" as const,
    };
    expect(() => bundledThirdPartyComponentPlan([duplicate, duplicate])).toThrow(
      "duplicate bundled component ink@7.0.5",
    );
  });

  it("declares the exact external and optional dependencies for bundled workspace manifests", () => {
    const manifests = NPX_BUNDLED_WORKSPACE_MANIFESTS.map((path) => readManifest(path));
    const deps = collectExternalDependencies(manifests);
    const optionalDeps = collectOptionalDependencies(manifests);

    expect(deps).toEqual({
      "@ai-sdk/anthropic": "3.0.81",
      "@ai-sdk/google": "3.0.80",
      "@ai-sdk/openai": "3.0.68",
      "@ai-sdk/openai-compatible": "2.0.58",
      "@noble/hashes": "1.8.0",
      "@open-policy-agent/opa-wasm": "1.10.0",
      "@vscode/ripgrep": "1.18.0",
      ai: "6.0.197",
      ink: "7.0.5",
      picomatch: "4.0.4",
      react: "19.2.7",
      typescript: "5.9.3",
      yaml: "1.10.3",
      zod: "3.25.76",
    });
    expect(Object.keys(deps)).toHaveLength(14);
    expect(Object.keys(deps).filter((name) => name.startsWith("@keel/"))).toEqual([]);
    expect(optionalDeps).toEqual({
      "@vscode/ripgrep-darwin-arm64": "1.18.0",
      "@vscode/ripgrep-darwin-x64": "1.18.0",
      "@vscode/ripgrep-linux-arm64": "1.18.0",
      "@vscode/ripgrep-linux-x64": "1.18.0",
    });
  });

  it("bundles reviewed runtime patches into npx while keeping React external", () => {
    const manifests = NPX_BUNDLED_WORKSPACE_MANIFESTS.map((path) => readManifest(path));
    const deps = collectNpxExternalDependencies(manifests);

    expect(NPX_BUNDLED_RUNTIME_DEPENDENCIES).toEqual([
      "ink",
      "cli-truncate",
      "slice-ansi",
      "cli-boxes",
    ]);
    expect(NPX_BUNDLED_RUNTIME_PACKAGES).toEqual([
      { name: "ink", version: "7.0.5", license: "MIT", licenseFile: "license" },
      { name: "cli-truncate", version: "6.0.0", license: "MIT", licenseFile: "license" },
      { name: "slice-ansi", version: "9.0.0", license: "MIT", licenseFile: "license" },
      { name: "cli-boxes", version: "4.0.1", license: "MIT", licenseFile: "license" },
    ]);
    for (const dependency of NPX_BUNDLED_RUNTIME_DEPENDENCIES) {
      expect(deps).not.toHaveProperty(dependency);
    }
    expect(deps).toHaveProperty("react", "19.2.7");
    expect(deps).toHaveProperty("typescript", "5.9.3");
  });

  it("rejects bundle bytes that disclose the absolute builder checkout", () => {
    expect(
      builderPathLeakReasons('const lib = "/Users/builder/keel/node_modules/typescript/lib";', [
        "/Users/builder/keel",
      ]),
    ).toEqual(["bundle embeds absolute builder path /Users/builder/keel"]);
    expect(
      builderPathLeakReasons('const root = "/Users/builder/keel";', ["/Users/builder/keel"]),
    ).toEqual(["bundle embeds absolute builder path /Users/builder/keel"]);
    expect(
      builderPathLeakReasons('const root = "C:\\\\work\\\\keel";', ["C:\\work\\keel"]),
    ).toEqual(["bundle embeds absolute builder path C:\\work\\keel"]);
    expect(
      builderPathLeakReasons('const sibling = "/Users/builder/keel-copy";', [
        "/Users/builder/keel",
      ]),
    ).toEqual([]);
    expect(
      builderPathLeakReasons("const temp = '/private/tmp/keel-out.txt';", ["/Users/builder/keel"]),
    ).toEqual([]);
    expect(() => builderPathLeakReasons("bundle", [""])).toThrow("builder path must not be empty");
  });

  it("merges exact dependencies of a bundled patched runtime and rejects version drift", () => {
    expect(
      mergeExactDependencies(
        { react: "19.2.7", zod: "3.25.76" },
        { "ansi-escapes": "7.3.0", react: "19.2.7" },
      ),
    ).toEqual({ "ansi-escapes": "7.3.0", react: "19.2.7", zod: "3.25.76" });
    expect(() => mergeExactDependencies({ react: "19.2.7" }, { react: "19.2.6" })).toThrow(
      "conflicting exact dependency version for react",
    );
    expect(() => mergeExactDependencies({ react: "^19.2.7" })).toThrow(
      "dependency react must use an exact semantic version",
    );
  });

  // ADR-0018 states esbuild "is pulled only by dev/build tooling, never shipped in any artifact",
  // and its exploitability argument rests on the repo's `ignore-scripts` — which is repo-local and
  // does NOT protect someone running `npx keel-harness`. `tsx` pulls `esbuild`, whose install runs a
  // `postinstall` script on the user's machine. The warden's only `tsx` use is a source-mode
  // fallback in `srt-runtime-loader`; the shipped artifact loads the vendored SRT through the
  // bundled path instead. The packaging build rejects source-mode bundle markers and the packaged
  // smoke executes governed bash with `sandbox on`, so the published package must not declare it.
  it("never ships a source-mode-only dependency that would run an install script on a user machine", () => {
    const manifests = NPX_BUNDLED_WORKSPACE_MANIFESTS.map((path) => readManifest(path));
    const deps = collectExternalDependencies(manifests);

    expect(Object.keys(deps)).not.toContain("tsx");
    expect(Object.keys(deps)).not.toContain("esbuild");
  });
});
