import { describe, expect, it } from "vitest";
import { createPublicNpxManifest, publicManifestProblems } from "./release-metadata.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function manifest() {
  return createPublicNpxManifest({
    version: "0.1.1",
    sourceCommit: COMMIT,
    sourceDirty: false,
    dependencies: { zod: "3.25.76" },
    optionalDependencies: { "@vscode/ripgrep-linux-x64": "1.18.0" },
    bundledComponents: [
      {
        name: "ink",
        version: "7.0.5",
        license: "MIT",
        source: "npm",
      },
    ],
  });
}

describe("public npm carrier metadata", () => {
  it("binds the carrier to the public project, source commit, command, and public access", () => {
    expect(manifest()).toMatchObject({
      name: "keel-harness",
      version: "0.1.1",
      license: "Apache-2.0",
      type: "module",
      bin: { keel: "./bin/keel.mjs" },
      engines: { node: ">=20" },
      homepage: "https://github.com/keel-harness/keel#readme",
      repository: {
        type: "git",
        url: "git+https://github.com/keel-harness/keel.git",
      },
      bugs: { url: "https://github.com/keel-harness/keel/issues" },
      publishConfig: { access: "public" },
      keelSource: {
        repository: "https://github.com/keel-harness/keel",
        commit: COMMIT,
        dirty: false,
      },
    });
    expect(publicManifestProblems(manifest())).toEqual([]);
  });

  it.each([
    ["private package", { private: true }, "must not be private"],
    ["wrong name", { name: "keel" }, "expected package name keel-harness"],
    ["workspace dependency", { dependencies: { zod: "workspace:*" } }, "workspace protocol"],
    ["ranged dependency", { dependencies: { zod: "^3.25.76" } }, "exact dependency"],
    [
      "private source URL",
      { repository: { type: "git", url: "git+https://github.com/private-owner/keel.git" } },
      "public repository",
    ],
  ])("rejects %s", (_label, change, reason) => {
    expect(publicManifestProblems({ ...manifest(), ...change })).toContain(reason);
  });
});
