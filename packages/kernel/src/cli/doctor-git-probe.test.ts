import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("doctor Git probe authority", () => {
  it("uses the process-separated Warden helper-authority verdict when available", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const operatorBin = tempDir("keel-doctor-git-operator-");
    const warden = join(operatorBin, "warden");
    executable(
      join(operatorBin, "git"),
      [
        'if [ "$1" = "--version" ]; then printf "git version 2.39.5\\n"; exit 0; fi',
        'if [ "$1" = "config" ] && [ "$2" = "--local" ]; then printf "https://github.com/keel-harness/keel.git\\n"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    );
    executable(warden, `printf '%s\\n' '{"status":"ok","detail":"eligible"}'`);

    expect(
      gatherDoctorGitProbe({
        workspaceRoot: workspace,
        platform: "darwin",
        env: { PATH: operatorBin },
        wardenStart: { command: warden, args: [] },
      }),
    ).toEqual({
      gitVersionRaw: "git version 2.39.5",
      gitRemoteUrlRaw: "https://github.com/keel-harness/keel.git",
      gitCredentialHelperConfigured: true,
    });
  });

  it("retains only a bounded Warden denial and remediation", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const operatorBin = tempDir("keel-doctor-git-operator-");
    const warden = join(operatorBin, "warden");
    executable(
      join(operatorBin, "git"),
      [
        'if [ "$1" = "--version" ]; then printf "git version 2.39.5\\n"; exit 0; fi',
        'if [ "$1" = "config" ] && [ "$2" = "--local" ]; then printf "https://github.com/keel-harness/keel.git\\n"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    );
    executable(
      warden,
      `printf '%s\\n' '{"status":"error","detail":"helper unsafe","fix":"gh auth setup-git && keel doctor"}'`,
    );

    expect(
      gatherDoctorGitProbe({
        workspaceRoot: workspace,
        platform: "darwin",
        env: { PATH: operatorBin },
        wardenStart: { command: warden, args: [] },
      }).gitCredentialHelperAuthorityIssue,
    ).toEqual({ detail: "helper unsafe", fix: "gh auth setup-git && keel doctor" });
  });

  it("fails closed for malformed, noisy, failed, and unavailable Warden probe responses", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const operatorBin = tempDir("keel-doctor-git-operator-");
    executable(
      join(operatorBin, "git"),
      [
        'if [ "$1" = "--version" ]; then printf "git version 2.39.5\\n"; exit 0; fi',
        'if [ "$1" = "config" ] && [ "$2" = "--local" ]; then printf "https://github.com/keel-harness/keel.git\\n"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    );
    const cases = [
      { body: "exit 2" },
      { body: "printf 'diagnostic\\n' >&2; exit 0" },
      { body: "exit 0" },
      { body: "printf 'one\\ntwo\\n'" },
      { body: `printf '%s\\n' 'null'` },
      { body: `printf '%s\\n' '[]'` },
      { body: `printf '%s\\n' '"text"'` },
      { body: `printf '%s\\n' '{"status":"ok","detail":""}'` },
      { body: `printf '%s\\n' '{"status":"error","detail":"unsafe"}'` },
      { body: `printf '%s\\n' '{"status":"unknown","detail":"x","fix":"y"}'` },
      { body: `printf '%s\\n' '{"status":"ok","status":"error","detail":"x"}'` },
    ];
    for (const [index, testCase] of cases.entries()) {
      const warden = join(operatorBin, `warden-${String(index)}`);
      executable(warden, testCase.body);
      const result = gatherDoctorGitProbe({
        workspaceRoot: workspace,
        platform: "linux",
        env: { PATH: operatorBin },
        wardenStart: { command: warden, args: [], env: { LANG: "C" } },
      });
      expect(result.gitCredentialHelperConfigured).toBe(false);
      expect(result.gitCredentialHelperAuthorityIssue).toEqual({
        detail: "Warden credential-helper authority probe unavailable",
        fix: "reinstall keel and run: keel doctor",
      });
    }

    const missing = gatherDoctorGitProbe({
      workspaceRoot: workspace,
      platform: "linux",
      env: { PATH: operatorBin },
      wardenStart: { command: join(operatorBin, "missing-warden"), args: [] },
    });
    expect(missing.gitCredentialHelperAuthorityIssue?.detail).toMatch(/probe unavailable/u);
  });

  it("uses process platform and environment defaults without widening executable selection", () => {
    const workspace = tempDir("keel-doctor-git-workspace-");
    const operatorBin = tempDir("keel-doctor-git-operator-");
    executable(
      join(operatorBin, "git"),
      'if [ "$1" = "--version" ]; then printf "git version 2.39.5\\n"; exit 0; fi\nexit 1',
    );
    vi.stubEnv("PATH", operatorBin);

    const result = gatherDoctorGitProbe({ workspaceRoot: workspace });

    expect(result.gitVersionRaw).toBe("git version 2.39.5");
    expect(result.gitRemoteUrlRaw).toBeNull();
  });

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
      gitCredentialHelperConfigured: false,
      gitCredentialHelperAuthorityIssue: {
        detail: "Warden credential-helper authority probe unavailable",
        fix: "reinstall keel and run: keel doctor",
      },
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

  it("does not infer helper authority from an ambient global helper probe", () => {
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

  it("does not infer helper authority from ambient reset ordering", () => {
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
      gitCredentialHelperAuthorityIssue: {
        detail: "Warden credential-helper authority probe unavailable",
        fix: "reinstall keel and run: keel doctor",
      },
    });
  });
});
