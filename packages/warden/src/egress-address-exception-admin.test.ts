import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  runEgressAddressExceptionAdminFromEnv,
  runEgressAddressExceptionAdminRequest,
} from "./egress-address-exception-admin.js";

const cleanupRoots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-egress-admin-")));
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

const ENTRY = {
  host: "registry.corp.example",
  cidr: "10.20.0.0/16",
  ports: [443],
} as const;

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("egress address exception admin process boundary", () => {
  it("returns strict add/list/remove responses without exposing unrelated workspaces", () => {
    const { env, workspace, otherWorkspace } = fixture();
    expect(
      runEgressAddressExceptionAdminRequest(
        { version: 1, operation: "add", workspace: otherWorkspace, exception: ENTRY },
        env,
      ),
    ).toMatchObject({ ok: true, result: { operation: "add", status: "added" } });
    expect(
      runEgressAddressExceptionAdminRequest(
        { version: 1, operation: "add", workspace, exception: ENTRY },
        env,
      ),
    ).toMatchObject({
      version: 1,
      ok: true,
      result: { operation: "add", status: "added", workspaceRealpath: workspace },
    });

    const listed = runEgressAddressExceptionAdminRequest(
      { version: 1, operation: "list", workspace },
      env,
    );
    expect(listed).toEqual({
      version: 1,
      ok: true,
      result: {
        operation: "list",
        workspaceRealpath: workspace,
        revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        exceptions: [ENTRY],
      },
    });
    expect(JSON.stringify(listed)).not.toContain(otherWorkspace);

    expect(
      runEgressAddressExceptionAdminRequest(
        { version: 1, operation: "remove", workspace, exception: ENTRY },
        env,
      ),
    ).toMatchObject({ ok: true, result: { operation: "remove", status: "removed" } });
  });

  it("bounds failures into a strict response instead of throwing authority diagnostics", () => {
    const { env, workspace } = fixture();
    const response = runEgressAddressExceptionAdminRequest(
      {
        version: 1,
        operation: "add",
        workspace,
        exception: { ...ENTRY, host: "metadata.google.internal" },
      },
      env,
    );
    expect(response).toMatchObject({ version: 1, ok: false });
    if (!response.ok) {
      expect(response.error.length).toBeLessThanOrEqual(480);
      expect(response.error).not.toContain("\n");
    }
  });

  it("decodes one base64 request and emits exactly one strict JSON response line", () => {
    const { env, workspace } = fixture();
    const output: string[] = [];
    const request = Buffer.from(
      JSON.stringify({ version: 1, operation: "list", workspace }),
      "utf8",
    ).toString("base64");

    runEgressAddressExceptionAdminFromEnv(
      {
        ...env,
        KEEL_INTERNAL_EGRESS_EXCEPTION_ADMIN: "1",
        KEEL_INTERNAL_EGRESS_EXCEPTION_ADMIN_REQUEST_B64: request,
      },
      (line) => output.push(line),
    );
    expect(output).toHaveLength(1);
    expect(output[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(output[0]!)).toMatchObject({
      version: 1,
      ok: true,
      result: { operation: "list", workspaceRealpath: workspace },
    });
  });

  it("fails closed on missing mode, malformed base64, or unknown request fields", () => {
    const outputs: string[] = [];
    for (const env of [
      {},
      {
        KEEL_INTERNAL_EGRESS_EXCEPTION_ADMIN: "1",
        KEEL_INTERNAL_EGRESS_EXCEPTION_ADMIN_REQUEST_B64: "not base64!",
      },
      {
        KEEL_INTERNAL_EGRESS_EXCEPTION_ADMIN: "1",
        KEEL_INTERNAL_EGRESS_EXCEPTION_ADMIN_REQUEST_B64: Buffer.from(
          JSON.stringify({ version: 1, operation: "list", workspace: "/tmp", extra: true }),
        ).toString("base64"),
      },
    ]) {
      runEgressAddressExceptionAdminFromEnv(env, (line) => outputs.push(line));
    }
    expect(outputs).toHaveLength(3);
    for (const output of outputs) {
      expect(JSON.parse(output)).toMatchObject({ version: 1, ok: false });
      expect(output.split("\n")).toHaveLength(2);
    }
  });
});
