/**
 * Real-backend sandbox DENIAL probes.
 *
 * Every other srt test in this package drives a FAKE runtime, so a green `pnpm test` proves the
 * warden's plumbing but NOT that the real OS sandbox (bubblewrap on Linux, seatbelt on macOS)
 * actually enforces anything. This suite closes that "hidden green" (launch-prep P1-4): it spawns
 * real commands through the vendored `@anthropic-ai/sandbox-runtime` and asserts that a denied
 * filesystem write and denied network egress are structurally blocked, with positive controls
 * proving the sandbox is not simply breaking everything.
 *
 * It is OPT-IN. In the default suite (`pnpm test` / `pnpm test:cov`) it is skipped, because the
 * tooling is not guaranteed present and coverage runs must stay hermetic. The dedicated
 * `sandbox-real` CI leg installs the tooling and runs it with `KEEL_REQUIRE_REAL_SANDBOX=1`, where
 * an unavailable sandbox is a hard FAILURE (see {@link resolveRealSandboxGate}) — so the leg can
 * never pass by silently skipping.
 *
 * Portability note: the assertions are written to hold on BOTH backends. Filesystem-write denial is
 * enforced by seatbelt's default-deny (macOS) and by bwrap's `--ro-bind / /` default (Linux); a
 * write outside `allowWrite` fails on both. Network denial is seatbelt `deny network*` (macOS) and
 * bwrap `--unshare-net` (Linux); a fully network-denied sandbox cannot reach a host listener the
 * same command reaches unsandboxed. Read confinement is asserted on content non-leakage (not exit
 * code) because Linux masks reads via a tmpfs overlay (empty content, exit 0) while macOS denies
 * outright (exit 1) — the security-relevant invariant, "the secret bytes never reach the process,"
 * holds on both.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discoverMcpServerWithSandbox } from "./mcp/local-stdio.js";
import { createVendoredSrtSandboxComponents } from "./srt-runtime-loader.js";
import { isRealSandboxRequired, resolveRealSandboxGate } from "./real-sandbox-gate.js";
import type { SandboxPort, SandboxProfile } from "./sandbox.js";
import { buildDefaultSandboxProfile } from "./sandbox-profile.js";
import { buildPolicyInputForBash, createDefaultPolicyPort } from "./policy.js";
import { createSandboxTypedMutationRunner } from "./typed-mutation-runner.js";
import {
  createTypedToolState,
  executeReadTool,
  prepareEditToolMutation,
  prepareWriteToolMutation,
} from "./typed-tools.js";

const required = isRealSandboxRequired(process.env);

// The whole-suite skip decision depends only on `required` (synchronous). Availability is checked in
// beforeAll, where — in require mode — an unavailable sandbox throws and turns the leg red.
const suite = required ? describe : describe.skip;

function runUnsandboxed(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

suite("real SRT sandbox enforcement (opt-in: KEEL_REQUIRE_REAL_SANDBOX=1)", () => {
  let sandbox: SandboxPort;
  let workRoot: string;

  beforeAll(async () => {
    const { sandbox: real } = await createVendoredSrtSandboxComponents();
    const status = real.status();
    const gate = resolveRealSandboxGate({
      required,
      available: status.available,
      ...(status.reason === undefined ? {} : { unavailableReason: status.reason }),
    });
    if (gate.action === "fail") throw new Error(gate.reason);
    // `required` is true whenever beforeAll runs (else the suite is describe.skip), so the only
    // non-fail outcome here is "run".
    sandbox = real;
    // realpathSync: macOS seatbelt canonicalizes paths (/var → /private/var), so the profile paths
    // must be the resolved form or even allowed writes would be denied.
    workRoot = realpathSync(mkdtempSync(join(tmpdir(), "keel-real-sbx-")));
    // Generous hook timeout: on Linux the first sandbox use cold-starts the srt HTTP/SOCKS proxies
    // and the socat network bridge, which can exceed vitest's 10s default hook budget on a loaded
    // runner. This is init latency, not a correctness signal.
  }, 30_000);

  afterAll(() => {
    if (workRoot !== undefined && existsSync(workRoot)) {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("reports the real vendored backend as available (the denial probes below prove enforcement)", () => {
    // `available`/`enforcementTier` are self-reported labels — a fake backend could set them. They
    // are NOT the enforcement evidence; the three denial probes below are (a backend that reported
    // available but did not enforce would fail them).
    const status = sandbox.status();
    expect(status.available).toBe(true);
    expect(status.enforcementTier).toBe("sandbox:srt");
  });

  it("discovers a local-stdio MCP server through the real vendored sandbox", async () => {
    const workspace = realpathSync(mkdtempSync(join(workRoot, "mcp-discovery-workspace-")));
    const home = join(workRoot, "home");
    const keelHome = join(workRoot, "keel-home");
    // Production creates <KEEL_HOME>/audit recursively before starting either the normal Warden or
    // hidden MCP discovery. Keep this direct-helper fixture on that path invariant: when KEEL_HOME
    // is absent, Linux bwrap must synthesize both the parent deny mount and nested audit/policy
    // mounts, which fails before the runner starts and tests vendored mount preparation instead.
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(keelHome, { mode: 0o700 });
    const serverPath = join(workspace, "fixture-server.mjs");
    writeFileSync(
      serverPath,
      `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const newline = buffer.indexOf("\\n");
            if (newline === -1) break;
            const request = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (request.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "real-srt-fixture", version: "1" }
                }
              }) + "\\n");
            }
            if (request.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: {
                  tools: [{
                    name: "echo",
                    description: "Echoes exact input",
                    inputSchema: {
                      type: "object",
                      properties: { text: { type: "string" } },
                      required: ["text"]
                    }
                  }]
                }
              }) + "\\n");
              setImmediate(() => process.exit(0));
            }
          }
        });
      `,
      { mode: 0o600 },
    );

    const discovery = await discoverMcpServerWithSandbox({
      sandbox,
      workspaceRoot: workspace,
      server: {
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        envKeys: [],
      },
      env: {
        ...process.env,
        HOME: home,
        KEEL_HOME: keelHome,
      },
      declaredTempRoots: [workRoot],
    });

    expect(discovery).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [
        {
          name: "echo",
          description: "Echoes exact input",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
    });
  });

  it("allows a write inside allowWrite (positive control)", async () => {
    const allowedDir = join(workRoot, "allowed");
    mkdirSync(allowedDir);
    const target = join(allowedDir, "ok.txt");
    const profile: SandboxProfile = {
      filesystem: { allowRead: [workRoot], allowWrite: [allowedDir], denyRead: [], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
    };
    const result = await sandbox.execute(
      { command: "/bin/sh", argv: ["/bin/sh", "-c", `printf keel-ok > ${target}`] },
      profile,
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("DENIES a write outside allowWrite", async () => {
    const allowedDir = join(workRoot, "allowed-2");
    mkdirSync(allowedDir);
    const forbidden = join(workRoot, "escaped.txt");
    const profile: SandboxProfile = {
      filesystem: { allowRead: [workRoot], allowWrite: [allowedDir], denyRead: [], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
    };
    const result = await sandbox.execute(
      { command: "/bin/sh", argv: ["/bin/sh", "-c", `printf pwned > ${forbidden}`] },
      profile,
    );
    // The escape must be structurally blocked: non-zero exit AND the file never created.
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(forbidden)).toBe(false);
  });

  it("DENIES Bash writes to execution metadata while allowing ordinary workspace writes", async () => {
    const workspace = realpathSync(mkdtempSync(join(workRoot, "metadata-workspace-")));
    const home = join(workRoot, "metadata-home");
    const keelHome = join(workRoot, "metadata-keel-home");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(keelHome, "audit"), { recursive: true, mode: 0o700 });
    mkdirSync(join(keelHome, "policy"), { recursive: true, mode: 0o700 });
    mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
    writeFileSync(join(workspace, "package.json"), "{}\n");
    writeFileSync(join(workspace, ".git", "config"), "[core]\n");
    const profile = buildDefaultSandboxProfile({
      workspaceRoot: workspace,
      env: { ...process.env, HOME: home, KEEL_HOME: keelHome },
    });

    const ordinary = join(workspace, "notes.txt");
    const allowed = await sandbox.execute(
      { command: "/bin/sh", argv: ["/bin/sh", "-c", `printf allowed > ${ordinary}`] },
      profile,
    );
    expect(allowed.exitCode).toBe(0);
    expect(readFileSync(ordinary, "utf8")).toBe("allowed");

    for (const target of [
      join(workspace, "package.json"),
      join(workspace, ".git", "config"),
      join(workspace, ".git", "hooks", "pre-commit"),
    ]) {
      const denied = await sandbox.execute(
        { command: "/bin/sh", argv: ["/bin/sh", "-c", `printf denied > ${target}`] },
        profile,
      );
      expect(denied.exitCode, target).not.toBe(0);
    }

    expect(readFileSync(join(workspace, "package.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).toBe("[core]\n");
    expect(existsSync(join(workspace, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("contains a Bash write when its previously-contained parent is relocated after policy classification", async () => {
    const workspace = realpathSync(mkdtempSync(join(workRoot, "bash-race-workspace-")));
    const outside = realpathSync(mkdtempSync(join(workRoot, "bash-race-outside-")));
    const tempRoot = realpathSync(mkdtempSync(join(workRoot, "bash-race-temp-")));
    const parent = join(workspace, "race-parent");
    const relocated = join(outside, "race-parent-relocated");
    const target = join(parent, "canary.txt");
    const outsideCanary = join(relocated, "canary.txt");
    mkdirSync(parent);
    const command = `printf keel-race > ${target}`;
    const profile: SandboxProfile = {
      filesystem: {
        allowRead: [workspace, tempRoot],
        allowWrite: [workspace, tempRoot],
        denyRead: [],
        denyWrite: [],
      },
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
    };

    const policyInput = buildPolicyInputForBash(
      {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCall: { id: "tc_bash_race", name: "bash", args: { command } },
        provenanceContext: { inputTags: ["workspace"] },
      },
      {
        workspaceRoot: workspace,
        workspaceTrusted: true,
        declaredTempRoots: [tempRoot],
        env: { HOME: join(workRoot, "home"), KEEL_HOME: join(workRoot, "keel-home") },
      },
    );
    expect(policyInput.sideEffect.dynamic.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalized: target, withinWorkspace: true }),
      ]),
    );
    expect(await (await createDefaultPolicyPort()).evaluate(policyInput)).toMatchObject({
      verdict: "allow",
    });

    const contained = await sandbox.execute(
      { command: "/bin/sh", argv: ["/bin/sh", "-c", command] },
      profile,
    );
    expect(contained.exitCode).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("keel-race");
    rmSync(target);

    renameSync(parent, relocated);
    symlinkSync(relocated, parent, "dir");
    const positiveControl = await runUnsandboxed("/bin/sh", ["-c", command]);
    expect(positiveControl.code).toBe(0);
    expect(readFileSync(outsideCanary, "utf8")).toBe("keel-race");
    rmSync(outsideCanary);

    const containedRace = await sandbox.execute(
      { command: "/bin/sh", argv: ["/bin/sh", "-c", command] },
      profile,
    );
    expect(containedRace.exitCode).not.toBe(0);
    expect(existsSync(outsideCanary)).toBe(false);
  });

  it("DENIES typed helper writes and edits after the prepared parent is relocated outside", async () => {
    const workspace = realpathSync(mkdtempSync(join(workRoot, "typed-helper-workspace-")));
    const outside = realpathSync(mkdtempSync(join(workRoot, "typed-helper-outside-")));
    const tempRoot = realpathSync(mkdtempSync(join(workRoot, "typed-helper-temp-")));
    const runner = createSandboxTypedMutationRunner({
      sandbox,
      declaredTempRoots: [tempRoot],
    });
    if (runner === undefined) throw new Error("expected SRT typed mutation runner");
    const profile: SandboxProfile = {
      filesystem: {
        allowRead: [workspace, tempRoot],
        allowWrite: [workspace, tempRoot],
        denyRead: [],
        denyWrite: [],
      },
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
    };

    const writeParent = join(workspace, "write-dir");
    const writeRelocated = join(outside, "write-relocated");
    const writeOutsideTarget = join(writeRelocated, "notes.txt");
    mkdirSync(writeParent);
    const writeMutation = prepareWriteToolMutation(
      { path: "write-dir/notes.txt", content: "ESCAPED" },
      { workspaceRoot: workspace, state: createTypedToolState() },
    );
    renameSync(writeParent, writeRelocated);
    symlinkSync(writeRelocated, writeParent, "dir");

    const writeSettlement = await runner.execute({
      tool: "write",
      workspaceRoot: workspace,
      profile,
      mutation: writeMutation,
    });
    expect(writeSettlement.mutation).toBe("failed");
    if (writeSettlement.mutation === "committed") throw new Error("write escaped containment");
    expect(writeSettlement.error.message).toMatch(/contained mutation helper failed/u);
    expect(existsSync(writeOutsideTarget)).toBe(false);

    const tempWriteParent = join(workspace, "temp-write-dir");
    const tempWriteRelocated = join(tempRoot, "temp-write-relocated");
    const tempWriteOutsideTarget = join(tempWriteRelocated, "notes.txt");
    mkdirSync(tempWriteParent);
    const tempWriteMutation = prepareWriteToolMutation(
      { path: "temp-write-dir/notes.txt", content: "ESCAPED" },
      { workspaceRoot: workspace, state: createTypedToolState() },
    );
    renameSync(tempWriteParent, tempWriteRelocated);
    symlinkSync(tempWriteRelocated, tempWriteParent, "dir");

    const tempWriteSettlement = await runner.execute({
      tool: "write",
      workspaceRoot: workspace,
      profile,
      mutation: tempWriteMutation,
    });
    expect(tempWriteSettlement.mutation).toBe("failed");
    if (tempWriteSettlement.mutation === "committed") {
      throw new Error("temporary-root write escaped containment");
    }
    expect(tempWriteSettlement.error.message).toMatch(/contained mutation helper failed/u);
    expect(existsSync(tempWriteOutsideTarget)).toBe(false);

    const editParent = join(workspace, "edit-dir");
    const editRelocated = join(outside, "edit-relocated");
    const editOutsideTarget = join(editRelocated, "notes.txt");
    const state = createTypedToolState();
    mkdirSync(editParent);
    writeFileSync(join(editParent, "notes.txt"), "alpha SECRET omega");
    executeReadTool({ path: "edit-dir/notes.txt" }, { workspaceRoot: workspace, state });
    const editMutation = prepareEditToolMutation(
      { path: "edit-dir/notes.txt", oldString: "SECRET", newString: "ESCAPED" },
      { workspaceRoot: workspace, state },
    );
    renameSync(editParent, editRelocated);
    symlinkSync(editRelocated, editParent, "dir");

    const editSettlement = await runner.execute({
      tool: "edit",
      workspaceRoot: workspace,
      profile,
      mutation: editMutation,
    });
    expect(editSettlement.mutation).toBe("failed");
    if (editSettlement.mutation === "committed") throw new Error("edit escaped containment");
    expect(editSettlement.error.message).toMatch(/contained mutation helper failed/u);
    expect(readFileSync(editOutsideTarget, "utf8")).toBe("alpha SECRET omega");
  });

  it("allows typed helper writes and edits inside the workspace", async () => {
    const workspace = realpathSync(mkdtempSync(join(workRoot, "typed-helper-allow-workspace-")));
    const tempRoot = realpathSync(mkdtempSync(join(workRoot, "typed-helper-allow-temp-")));
    const runner = createSandboxTypedMutationRunner({
      sandbox,
      declaredTempRoots: [tempRoot],
    });
    if (runner === undefined) throw new Error("expected SRT typed mutation runner");
    const profile: SandboxProfile = {
      filesystem: {
        allowRead: [workspace, tempRoot],
        allowWrite: [workspace, tempRoot],
        denyRead: [],
        denyWrite: [],
      },
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
    };
    const state = createTypedToolState();
    const writeMutation = prepareWriteToolMutation(
      { path: "notes.txt", content: "alpha beta\n" },
      { workspaceRoot: workspace, state },
    );

    await runner.execute({
      tool: "write",
      workspaceRoot: workspace,
      profile,
      mutation: writeMutation,
    });
    expect(writeMutation.commit()).toBe("write: created 'notes.txt' (11 bytes)");
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("alpha beta\n");

    executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace, state });
    const editMutation = prepareEditToolMutation(
      { path: "notes.txt", oldString: "beta", newString: "gamma" },
      { workspaceRoot: workspace, state },
    );

    await runner.execute({
      tool: "edit",
      workspaceRoot: workspace,
      profile,
      mutation: editMutation,
    });
    expect(editMutation.commit()).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("alpha gamma\n");
  });

  it("does not leak the bytes of a denyRead secret to the sandboxed process", async () => {
    const secret = join(workRoot, "secret.txt");
    const marker = "TOP-SECRET-KEEL-P1-4";
    writeFileSync(secret, marker);
    const readable = join(workRoot, "readable.txt");
    const readableMarker = "PUBLIC-KEEL-P1-4";
    writeFileSync(readable, readableMarker);
    const profile: SandboxProfile = {
      filesystem: {
        allowRead: [workRoot],
        allowWrite: [workRoot],
        denyRead: [secret],
        denyWrite: [],
      },
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
    };

    // Positive control: `cat` of a NON-denied file in the same profile returns its bytes. This
    // proves `cat` runs and can read at all — so a failed secret read below is the denyRead mask,
    // not a broken/absent `cat` (which would make the non-leak assertion vacuous).
    const control = await sandbox.execute(
      { command: "/bin/cat", argv: ["/bin/cat", readable] },
      profile,
    );
    expect(control.exitCode).toBe(0);
    expect(control.stdout).toContain(readableMarker);

    const result = await sandbox.execute(
      { command: "/bin/cat", argv: ["/bin/cat", secret] },
      profile,
    );
    // The security invariant: the secret's bytes never reach the process. (Linux masks the file to
    // empty content with exit 0; macOS denies outright with exit 1 — both satisfy this.)
    expect(result.stdout).not.toContain(marker);
  });

  it("DENIES network egress that the same command makes unsandboxed", async () => {
    // A local listener → deterministic, needs no external network. On macOS seatbelt blocks the
    // connect; on Linux `--unshare-net` gives the sandbox its own namespace-local loopback, so the
    // host listener is unreachable. NOTE: this proves total network restriction (the sandbox cannot
    // reach a service the same command reaches unsandboxed) — it is NOT a test of egress *allowlist*
    // granularity (which is the warden proxy's job and is covered elsewhere). If `--unshare-net` /
    // seatbelt `deny network*` were dropped, sandboxed curl would REACH and this goes red.
    const server = createServer((_req, res) => {
      res.end("REACHED");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address for the loopback listener");
    }
    const url = `http://127.0.0.1:${address.port}/`;
    // `--noproxy '*'`: never route the probe through a runner-configured http(s)_proxy (self-hosted
    // / enterprise / fork runners may set one), which would otherwise fail the loopback fetch for a
    // reason unrelated to the sandbox.
    const curlArgs = ["-s", "--noproxy", "*", "--max-time", "5", url];
    try {
      // Positive control: unsandboxed, the listener is reachable (spawned async so the in-process
      // server's event loop is free to answer). This also proves `curl` exists and works on the
      // host, so a sandboxed failure below is the sandbox — not a missing/broken curl.
      const unsandboxed = await runUnsandboxed("curl", curlArgs);
      expect(unsandboxed.code).toBe(0);
      expect(unsandboxed.stdout).toContain("REACHED");

      const profile: SandboxProfile = {
        filesystem: { allowRead: [workRoot], allowWrite: [workRoot], denyRead: [], denyWrite: [] },
        network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
      };
      const result = await sandbox.execute(
        { command: "curl", argv: ["curl", ...curlArgs] },
        profile,
      );
      expect(result.stdout).not.toContain("REACHED");
      // Discriminate "sandbox blocked the connection" from "curl never launched": curl's own error
      // codes are 1..94 (e.g. 7 = couldn't connect). A shell "command not found" (127) or a signal
      // (128+) would mean the process never really ran — that must not count as a denial.
      expect(result.exitCode).not.toBeNull();
      expect(result.exitCode).toBeGreaterThan(0);
      expect(result.exitCode).toBeLessThan(126);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
