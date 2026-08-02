import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EGRESS_EXCEPTIONS_USAGE, runEgressExceptionCommandResult } from "./egress-exceptions.js";

const cleanupRoots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-egress-exception-cli-")));
  cleanupRoots.push(root);
  const keelHome = join(root, "keel-home");
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  mkdirSync(keelHome, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(otherWorkspace, { mode: 0o700 });
  return {
    env: { KEEL_HOME: keelHome },
    workspace: realpathSync(workspace),
    otherWorkspace: realpathSync(otherWorkspace),
  };
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("keel egress exception", () => {
  it("adds, lists, and removes one exact workspace-host-CIDR-port tuple", () => {
    const { env, workspace } = fixture();
    const added = runEgressExceptionCommandResult({
      env,
      args: [
        "add",
        "--workspace",
        workspace,
        "--host",
        "registry.corp.example",
        "--cidr",
        "10.20.0.0/16",
        "--port",
        "8443",
        "--port=443",
      ],
    });
    expect(added.ok).toBe(true);
    expect(added.output).toContain("added egress address exception");
    expect(added.output).toContain("ports: 443, 8443");
    expect(added.output).toContain("The running Warden still uses its prior immutable snapshot.");
    expect(added.output).toContain(
      "Restart action: stop it, then run `keel --continue` from the workspace above.",
    );

    const listed = runEgressExceptionCommandResult({
      env,
      args: ["list", `--workspace=${workspace}`],
    });
    expect(listed).toMatchObject({ ok: true });
    expect(listed.output).toContain(`Egress address exceptions for ${workspace}`);
    expect(listed.output).toContain("- registry.corp.example · 10.20.0.0/16 · ports 443, 8443");

    const removed = runEgressExceptionCommandResult({
      env,
      args: [
        "remove",
        "--workspace",
        workspace,
        "--host=registry.corp.example",
        "--cidr=10.20.0.0/16",
        "--port=443",
        "--port=8443",
      ],
    });
    expect(removed).toMatchObject({ ok: true });
    expect(removed.output).toContain("removed egress address exception");
    expect(
      runEgressExceptionCommandResult({ env, args: ["list", "--workspace", workspace] }).output,
    ).toContain("no exceptions");
  });

  it("requires an explicit workspace and exact add/remove flags", () => {
    const { env, workspace } = fixture();
    const invalid = [
      ["list"],
      ["list", "--workspace", workspace, "--host", "private.example"],
      ["add", "--workspace", workspace, "--host", "private.example", "--cidr", "10.0.0.0/8"],
      [
        "add",
        "--workspace",
        workspace,
        "--workspace",
        workspace,
        "--host",
        "private.example",
        "--cidr",
        "10.0.0.0/8",
        "--port",
        "443",
      ],
      [
        "remove",
        "--workspace",
        workspace,
        "--host",
        "private.example",
        "--cidr",
        "10.0.0.0/8",
        "--port",
        "0",
      ],
      ["frob", "--workspace", workspace],
    ];

    for (const args of invalid) {
      expect(runEgressExceptionCommandResult({ env, args })).toEqual({
        ok: false,
        output: EGRESS_EXCEPTIONS_USAGE,
      });
    }
  });

  it("reports duplicate and missing mutations as successful no-ops without restart claims", () => {
    const { env, workspace } = fixture();
    const args = [
      "add",
      "--workspace",
      workspace,
      "--host",
      "private.example",
      "--cidr",
      "10.20.0.0/16",
      "--port",
      "443",
    ];
    expect(runEgressExceptionCommandResult({ env, args }).ok).toBe(true);

    const duplicate = runEgressExceptionCommandResult({ env, args });
    expect(duplicate).toEqual({
      ok: true,
      output: "egress address exception already present; no file change",
    });
    const missing = runEgressExceptionCommandResult({
      env,
      args: [
        "remove",
        "--workspace",
        workspace,
        "--host",
        "other.example",
        "--cidr",
        "10.20.0.0/16",
        "--port",
        "443",
      ],
    });
    expect(missing).toEqual({
      ok: true,
      output: "no matching egress address exception; no file change",
    });
  });

  it("never prints another workspace's entries", () => {
    const { env, workspace, otherWorkspace } = fixture();
    runEgressExceptionCommandResult({
      env,
      args: [
        "add",
        "--workspace",
        otherWorkspace,
        "--host",
        "other.private.example",
        "--cidr",
        "192.0.2.0/24",
        "--port",
        "443",
      ],
    });

    const listed = runEgressExceptionCommandResult({
      env,
      args: ["list", "--workspace", workspace],
    });
    expect(listed.output).toContain("no exceptions");
    expect(listed.output).not.toContain("other.private.example");
    expect(listed.output).not.toContain(otherWorkspace);
  });

  it("returns one bounded failure line for invalid authority instead of a stack", () => {
    const { env, workspace } = fixture();
    const result = runEgressExceptionCommandResult({
      env,
      args: [
        "add",
        "--workspace",
        workspace,
        "--host",
        "metadata.google.internal",
        "--cidr",
        "10.20.0.0/16",
        "--port",
        "443",
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/^keel egress exception: /u);
    expect(result.output.split("\n")).toHaveLength(1);
    expect(result.output.length).toBeLessThanOrEqual(512);
    expect(result.output).not.toContain("Error:");
  });
});
