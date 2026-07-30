import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function hostEnvWithoutRendererState(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["NODE_ENV"];
  delete env["KEEL_HOST_NODE_ENV"];
  delete env["KEEL_HOST_NODE_ENV_MANAGED"];
  return env;
}

function loadedReactRuntime(entry: string, env: NodeJS.ProcessEnv): string[] {
  return JSON.parse(
    execFileSync(process.execPath, [entry], { encoding: "utf8", env }).trim(),
  ) as string[];
}

describe("released renderer runtime mode (ADR-0083)", () => {
  it("loads React production builds through the npx launcher, with an unset-host dev negative control", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-renderer-mode-"));
    const launcher = join(dir, "keel.mjs");
    const kernelStub = join(dir, "keel-kernel.mjs");
    const kernelPackage = join(repoRoot, "packages", "kernel", "package.json");
    try {
      writeFileSync(
        launcher,
        readFileSync(join(repoRoot, "packaging", "npx-cli-entry.js"), "utf8"),
        "utf8",
      );
      writeFileSync(
        kernelStub,
        `
          import { createRequire } from "node:module";
          const externalRequire = createRequire(${JSON.stringify(kernelPackage)});
          externalRequire("react");
          externalRequire("react/jsx-dev-runtime");
          const loaded = Object.keys(externalRequire.cache)
            .map((entry) => entry.replaceAll("\\\\", "/"))
            .filter((entry) => entry.includes("/react/cjs/"));
          process.stdout.write(JSON.stringify(loaded));
        `,
        "utf8",
      );

      const cleanHostEnv = hostEnvWithoutRendererState();
      const launched = loadedReactRuntime(launcher, cleanHostEnv);
      expect(launched.some((entry) => entry.endsWith("/react.production.js"))).toBe(true);
      expect(launched.some((entry) => entry.endsWith("/react-jsx-dev-runtime.production.js"))).toBe(
        true,
      );
      expect(launched.some((entry) => entry.endsWith(".development.js"))).toBe(false);

      const negativeControl = loadedReactRuntime(kernelStub, cleanHostEnv);
      expect(negativeControl.some((entry) => entry.endsWith("/react.development.js"))).toBe(true);
      expect(
        negativeControl.some((entry) => entry.endsWith("/react-jsx-dev-runtime.development.js")),
      ).toBe(true);
      expect(negativeControl.some((entry) => entry.endsWith(".production.js"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
