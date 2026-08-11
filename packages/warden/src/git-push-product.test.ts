import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProductionGitExecutable } from "./git-push-product.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function fakeGit(directory: string, version = "2.39.5"): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "git");
  writeFileSync(path, `#!/bin/sh\nprintf 'git version ${version}\\n'\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function fakeGitProgram(directory: string, body: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "git");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production git.push executable authority", () => {
  it("selects one canonical executable outside the trusted workspace", () => {
    const workspace = tempDir("keel-git-product-workspace-");
    const operatorBin = tempDir("keel-git-product-bin-");
    const git = fakeGit(operatorBin);

    expect(
      resolveProductionGitExecutable({
        workspaceRoot: workspace,
        env: { PATH: operatorBin },
        platform: "darwin",
      }),
    ).toEqual({ path: git, version: "2.39.5" });
  });

  it("rejects project-controlled, relative, missing, and unsupported executable authority", () => {
    const workspace = tempDir("keel-git-product-workspace-");
    const projectBin = join(workspace, "bin");
    const outside = tempDir("keel-git-product-outside-");
    fakeGit(projectBin);

    for (const input of [
      { PATH: projectBin },
      { PATH: ["relative-bin", projectBin].join(delimiter) },
      { PATH: outside },
    ]) {
      expect(
        resolveProductionGitExecutable({
          workspaceRoot: workspace,
          env: input,
          platform: "linux",
        }),
      ).toBeUndefined();
    }
    expect(
      resolveProductionGitExecutable({
        workspaceRoot: workspace,
        env: { PATH: projectBin },
        platform: "win32",
      }),
    ).toBeUndefined();
  });

  it("withholds unproven Git versions and continues to a supported operator binary", () => {
    const workspace = tempDir("keel-git-product-workspace-");
    const oldBin = tempDir("keel-git-product-old-bin-");
    const supportedBin = tempDir("keel-git-product-supported-bin-");
    fakeGit(oldBin, "2.38.5");
    const supported = fakeGit(supportedBin, "2.39.0");

    expect(
      resolveProductionGitExecutable({
        workspaceRoot: workspace,
        env: { PATH: oldBin },
        platform: "linux",
      }),
    ).toBeUndefined();
    expect(
      resolveProductionGitExecutable({
        workspaceRoot: workspace,
        env: { PATH: [oldBin, supportedBin].join(delimiter) },
        platform: "linux",
      }),
    ).toEqual({ path: supported, version: "2.39.0" });
  });

  it("uses the host platform/PATH defaults while retaining canonical executable authority", () => {
    const workspace = tempDir("keel-git-product-workspace-");
    const operatorBin = tempDir("keel-git-product-default-bin-");
    const git = fakeGit(operatorBin);
    vi.stubEnv("PATH", operatorBin);

    expect(resolveProductionGitExecutable({ workspaceRoot: workspace })).toEqual({
      path: git,
      version: "2.39.5",
    });
  });

  it("skips executable probes that fail, exit nonzero, or terminate by signal", () => {
    const workspace = tempDir("keel-git-product-workspace-");
    const spawnErrorBin = tempDir("keel-git-product-spawn-error-");
    const nonzeroBin = tempDir("keel-git-product-nonzero-");
    const signalBin = tempDir("keel-git-product-signal-");
    const supportedBin = tempDir("keel-git-product-fallback-");

    mkdirSync(spawnErrorBin, { recursive: true });
    const spawnErrorGit = join(spawnErrorBin, "git");
    writeFileSync(spawnErrorGit, "#!/definitely/missing/interpreter\n", { mode: 0o700 });
    chmodSync(spawnErrorGit, 0o700);
    fakeGitProgram(nonzeroBin, "exit 17");
    fakeGitProgram(signalBin, "kill -TERM $$");
    const supported = fakeGit(supportedBin);

    expect(
      resolveProductionGitExecutable({
        workspaceRoot: workspace,
        env: {
          PATH: [spawnErrorBin, nonzeroBin, signalBin, supportedBin].join(delimiter),
        },
        platform: "linux",
      }),
    ).toEqual({ path: supported, version: "2.39.5" });
  });
});
