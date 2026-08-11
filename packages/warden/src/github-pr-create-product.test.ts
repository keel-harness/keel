import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProductionCurlExecutable } from "./github-pr-create-product.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function fakeCurl(directory: string, version = "8.7.1"): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "curl");
  writeFileSync(
    path,
    `#!/bin/sh\n[ "$1" = "--disable" ] && [ "$2" = "--version" ] || exit 91\nprintf 'curl ${version} test-platform\\n'\n`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return realpathSync(path);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production github.pr.create curl authority", () => {
  it.each(["7.61.0", "7.88.1", "8.0.0", "8.12.1"])(
    "selects a supported canonical curl %s outside the workspace",
    (version) => {
      const workspace = tempDir("keel-github-pr-workspace-");
      const operatorBin = tempDir("keel-github-pr-curl-");
      const curl = fakeCurl(operatorBin, version);

      expect(
        resolveProductionCurlExecutable({
          workspaceRoot: workspace,
          env: { PATH: operatorBin },
          platform: "darwin",
        }),
      ).toEqual({ path: curl, version });
    },
  );

  it("rejects project-controlled, relative, missing, unsupported, and future-major curl", () => {
    const workspace = tempDir("keel-github-pr-workspace-");
    const projectBin = join(workspace, "bin");
    const oldBin = tempDir("keel-github-pr-old-curl-");
    const futureBin = tempDir("keel-github-pr-future-curl-");
    const malformedBin = tempDir("keel-github-pr-malformed-curl-");
    fakeCurl(projectBin);
    fakeCurl(oldBin, "7.60.0");
    fakeCurl(futureBin, "9.0.0");
    fakeCurl(malformedBin, "not-a-version");

    for (const path of [
      projectBin,
      ["relative-bin", projectBin].join(delimiter),
      oldBin,
      futureBin,
      malformedBin,
      tempDir("keel-github-pr-missing-curl-"),
    ]) {
      expect(
        resolveProductionCurlExecutable({
          workspaceRoot: workspace,
          env: { PATH: path },
          platform: "linux",
        }),
      ).toBeUndefined();
    }
    expect(
      resolveProductionCurlExecutable({
        workspaceRoot: workspace,
        env: { PATH: oldBin },
        platform: "win32",
      }),
    ).toBeUndefined();
  });

  it("skips failed probes and continues to a supported operator binary", () => {
    const workspace = tempDir("keel-github-pr-workspace-");
    const failedBin = tempDir("keel-github-pr-failed-curl-");
    const supportedBin = tempDir("keel-github-pr-supported-curl-");
    mkdirSync(failedBin, { recursive: true });
    writeFileSync(join(failedBin, "curl"), "#!/bin/sh\nexit 17\n", { mode: 0o700 });
    const curl = fakeCurl(supportedBin);

    expect(
      resolveProductionCurlExecutable({
        workspaceRoot: workspace,
        env: { PATH: [failedBin, supportedBin].join(delimiter) },
        platform: "linux",
      }),
    ).toEqual({ path: curl, version: "8.7.1" });
  });

  it("fails closed when the workspace cannot be resolved and tolerates an absent operator PATH", () => {
    const missingWorkspace = join(tempDir("keel-github-pr-missing-workspace-"), "absent");
    expect(
      resolveProductionCurlExecutable({
        workspaceRoot: missingWorkspace,
        env: { PATH: "/usr/bin" },
        platform: "darwin",
      }),
    ).toBeUndefined();

    const workspace = tempDir("keel-github-pr-workspace-");
    expect(
      resolveProductionCurlExecutable({ workspaceRoot: workspace, env: {}, platform: "linux" }),
    ).toBeUndefined();
  });
});
