import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatherDoctorGitProbe } from "./doctor-git-probe.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function executable(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("doctor Git probe authority", () => {
  it("never executes a workspace PATH canary and probes one exact supported operator Git", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const projectBin = join(workspace, "node_modules", ".bin");
    const operatorBin = tempDir("keel-doctor-git-operator-");
    const canary = join(workspace, "canary-executed");
    executable(join(projectBin, "git"), `touch '${canary}'\nprintf 'git version 2.46.0\\n'`);
    executable(
      join(operatorBin, "git"),
      [
        'if [ "$1" = "--version" ]; then printf "git version 2.39.5\\n"; exit 0; fi',
        'if [ "$1" = "config" ] && [ "$2" = "--local" ]; then printf "https://github.com/keel-harness/keel.git\\n"; exit 0; fi',
        'if [ "$1" = "config" ] && [ "$2" = "--global" ]; then printf "credential.helper osxkeychain\\n"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    );

    expect(
      gatherDoctorGitProbe({
        workspaceRoot: workspace,
        platform: "darwin",
        env: { PATH: [projectBin, operatorBin].join(delimiter) },
      }),
    ).toEqual({
      gitVersionRaw: "git version 2.39.5",
      gitRemoteUrlRaw: "https://github.com/keel-harness/keel.git",
      gitCredentialHelperConfigured: true,
    });
    expect(existsSync(canary)).toBe(false);
  });

  it("returns an unavailable probe when no supported absolute operator Git exists", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const oldBin = tempDir("keel-doctor-git-old-");
    executable(join(oldBin, "git"), 'printf "git version 2.38.5\\n"');

    expect(
      gatherDoctorGitProbe({
        workspaceRoot: workspace,
        platform: "linux",
        env: { PATH: ["relative", oldBin].join(delimiter) },
      }),
    ).toEqual({
      gitVersionRaw: null,
      gitRemoteUrlRaw: null,
      gitCredentialHelperConfigured: false,
    });
  });

  it("does not treat an empty credential.helper reset as an available operator helper", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const operatorBin = tempDir("keel-doctor-git-operator-");
    executable(
      join(operatorBin, "git"),
      [
        'if [ "$1" = "--version" ]; then printf "git version 2.39.5\\n"; exit 0; fi',
        'if [ "$1" = "config" ] && [ "$2" = "--global" ]; then printf "credential.helper \\n"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    );

    expect(
      gatherDoctorGitProbe({
        workspaceRoot: workspace,
        platform: "linux",
        env: { PATH: operatorBin },
      }).gitCredentialHelperConfigured,
    ).toBe(false);
  });

  it("applies an empty helper reset after an earlier configured helper", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const operatorBin = tempDir("keel-doctor-git-operator-");
    executable(
      join(operatorBin, "git"),
      [
        'if [ "$1" = "--version" ]; then printf "git version 2.39.5\\n"; exit 0; fi',
        'if [ "$1" = "config" ] && [ "$2" = "--global" ]; then printf "credential.helper osxkeychain\\ncredential.helper \\n"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    );

    expect(
      gatherDoctorGitProbe({
        workspaceRoot: workspace,
        platform: "linux",
        env: { PATH: operatorBin },
      }).gitCredentialHelperConfigured,
    ).toBe(false);
  });

  it("fails closed for an unsupported host, missing workspace, and absent PATH", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const unavailable = {
      gitVersionRaw: null,
      gitRemoteUrlRaw: null,
      gitCredentialHelperConfigured: false,
    };

    expect(gatherDoctorGitProbe({ workspaceRoot: workspace, platform: "win32", env: {} })).toEqual(
      unavailable,
    );
    expect(
      gatherDoctorGitProbe({
        workspaceRoot: join(workspace, "missing"),
        platform: "linux",
        env: {},
      }),
    ).toEqual(unavailable);
    expect(gatherDoctorGitProbe({ workspaceRoot: workspace, platform: "linux", env: {} })).toEqual(
      unavailable,
    );
  });

  it("skips missing entries and a Git executable whose version probe fails", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const operatorBin = tempDir("keel-doctor-git-operator-");
    executable(join(operatorBin, "git"), "exit 9");

    expect(
      gatherDoctorGitProbe({
        workspaceRoot: workspace,
        platform: "linux",
        env: { PATH: [join(workspace, "missing-bin"), operatorBin].join(delimiter) },
      }),
    ).toEqual({
      gitVersionRaw: null,
      gitRemoteUrlRaw: null,
      gitCredentialHelperConfigured: false,
    });
  });

  it("preserves a no-newline remote and rejects blank or malformed helper records", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const operatorBin = tempDir("keel-doctor-git-operator-");
    executable(
      join(operatorBin, "git"),
      [
        'if [ "$1" = "--version" ]; then printf "git version 2.39.5\\n"; exit 0; fi',
        'if [ "$1" = "config" ] && [ "$2" = "--local" ]; then printf "https://github.com/keel-harness/keel.git"; exit 0; fi',
        'if [ "$1" = "config" ] && [ "$2" = "--system" ]; then printf "\\n"; exit 0; fi',
        'if [ "$1" = "config" ] && [ "$2" = "--global" ]; then printf "malformed-helper-record"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    );

    expect(
      gatherDoctorGitProbe({
        workspaceRoot: workspace,
        platform: "linux",
        env: { PATH: operatorBin },
      }),
    ).toEqual({
      gitVersionRaw: "git version 2.39.5",
      gitRemoteUrlRaw: "https://github.com/keel-harness/keel.git",
      gitCredentialHelperConfigured: false,
    });
  });
});
