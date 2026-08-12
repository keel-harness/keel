import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  doctorHarnessExecutablePaths,
  probeDoctorExecutable,
  resolveDoctorExecutable,
  resolveDoctorSelectedExecutable,
} from "./doctor-executable-probe.js";

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

describe("doctor executable probe authority", () => {
  it("includes the compiled carrier command but not the host Node executable", () => {
    const compiled = doctorHarnessExecutablePaths("/opt/rg", {
      command: "/workspace/keel",
      args: [],
      env: { KEEL_INTERNAL_WARDEN_STDIO: "1" },
    });
    const node = doctorHarnessExecutablePaths("/opt/rg", {
      command: "/usr/local/bin/node",
      args: ["/opt/keel/keel-warden.mjs"],
    });

    expect(compiled).toEqual(["/opt/rg", "/workspace/keel"]);
    expect(node).toEqual(["/opt/rg", "/opt/keel/keel-warden.mjs"]);
  });

  it("omits unavailable and non-absolute executable candidates", () => {
    expect(doctorHarnessExecutablePaths(undefined, undefined)).toEqual([]);
    expect(doctorHarnessExecutablePaths("/opt/rg", undefined)).toEqual(["/opt/rg"]);
    expect(
      doctorHarnessExecutablePaths(undefined, {
        command: "keel",
        args: ["--warden", "file:///opt/keel/keel-warden.mjs", "/opt/keel/warden-entry.mjs"],
        env: { KEEL_INTERNAL_WARDEN_STDIO: "1" },
      }),
    ).toEqual(["/opt/keel/warden-entry.mjs"]);
  });

  it("probes an exact preselected bundled executable even when the install is inside the workspace", () => {
    const workspace = tempDir("keel-doctor-executable-workspace-");
    const bundled = join(workspace, "node_modules", "@vscode", "ripgrep", "bin", "rg");
    executable(bundled, "printf 'ripgrep 14.1.1 bundled\n'");

    const resolved = resolveDoctorSelectedExecutable(bundled);

    expect(resolved).toBe(realpathSync(bundled));
    expect(resolved === undefined ? null : probeDoctorExecutable(resolved, ["--version"])).toBe(
      "ripgrep 14.1.1 bundled",
    );
  });

  it.each(["rg", "bwrap", "socat"])(
    "never executes a workspace %s canary and selects one exact outside executable",
    (command) => {
      const workspace = tempDir("keel-doctor-executable-workspace-");
      const projectBin = join(workspace, "node_modules", ".bin");
      const operatorBin = tempDir("keel-doctor-executable-operator-");
      const canary = join(workspace, `${command}-executed`);
      executable(join(projectBin, command), `touch '${canary}'\nprintf 'hostile\n'`);
      executable(join(operatorBin, command), `printf '${command} safe-version\n'`);
      const env = { PATH: [projectBin, operatorBin].join(delimiter) };

      const resolved = resolveDoctorExecutable(command, { workspaceRoot: workspace, env });

      expect(resolved).toBe(realpathSync(join(operatorBin, command)));
      expect(
        resolved === undefined ? null : probeDoctorExecutable(resolved, ["--version"], { env }),
      ).toBe(`${command} safe-version`);
      expect(existsSync(canary)).toBe(false);
    },
  );

  it("rejects relative PATH entries and explicit workspace-contained paths", () => {
    const workspace = tempDir("keel-doctor-executable-workspace-");
    const projectBin = join(workspace, "bin");
    executable(join(projectBin, "rg"), "printf 'hostile\n'");

    expect(
      resolveDoctorExecutable("rg", {
        workspaceRoot: workspace,
        env: { PATH: ["relative", projectBin].join(delimiter) },
      }),
    ).toBeUndefined();
    expect(
      resolveDoctorExecutable(join(projectBin, "rg"), {
        workspaceRoot: workspace,
        env: { PATH: projectBin },
      }),
    ).toBeUndefined();
  });

  it("fails closed for missing authority, malformed commands, and non-canonical probes", () => {
    const workspace = tempDir("keel-doctor-executable-workspace-");
    const operatorBin = tempDir("keel-doctor-executable-operator-");
    const failing = join(operatorBin, "failing");
    const alias = join(operatorBin, "alias");
    executable(failing, "exit 7");
    symlinkSync(failing, alias);

    expect(
      resolveDoctorExecutable("rg", {
        workspaceRoot: join(workspace, "missing"),
        env: { PATH: operatorBin },
      }),
    ).toBeUndefined();
    expect(resolveDoctorExecutable("", { workspaceRoot: workspace, env: {} })).toBeUndefined();
    expect(
      resolveDoctorExecutable("nested/rg", { workspaceRoot: workspace, env: {} }),
    ).toBeUndefined();
    expect(resolveDoctorExecutable("rg", { workspaceRoot: workspace, env: {} })).toBeUndefined();
    expect(
      resolveDoctorExecutable(join(operatorBin, "missing"), { workspaceRoot: workspace, env: {} }),
    ).toBeUndefined();
    expect(resolveDoctorSelectedExecutable("relative")).toBeUndefined();
    expect(resolveDoctorSelectedExecutable(join(operatorBin, "missing"))).toBeUndefined();
    expect(probeDoctorExecutable("relative", [])).toBeNull();
    expect(probeDoctorExecutable(alias, [])).toBeNull();
    expect(probeDoctorExecutable(failing, [])).toBeNull();
  });
});
