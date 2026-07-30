import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor } from "../local-executor.js";
import { PipeShellSession } from "./shell-session.js";
import { Workspace } from "./workspace.js";
import { coreToolSpecs, createCoreTools, registerCoreTools } from "./index.js";

let root: string;
let session: PipeShellSession;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keel-tools-")));
  session = new PipeShellSession({ cwd: root });
});
afterEach(async () => {
  await session.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("createCoreTools", () => {
  it("assembles the five core tools in canonical order", () => {
    const tools = createCoreTools(new Workspace(root), session);
    expect(tools.map((t) => t.spec.name)).toEqual(["read", "write", "edit", "bash", "search"]);
  });

  it("does not advertise interactive console tools on the local ungoverned runtime", () => {
    const tools = createCoreTools(new Workspace(root), session);
    expect(coreToolSpecs(tools).map((spec) => spec.name)).not.toEqual(
      expect.arrayContaining([
        "interactive_console.open",
        "interactive_console.send_keys",
        "interactive_console.read_screen",
        "interactive_console.release",
        "interactive_console.close",
      ]),
    );
  });

  it("threads a non-production bash timeout ceiling into the bash tool spec", () => {
    const tools = createCoreTools(new Workspace(root), session, { bashMaxTimeoutMs: 10_800_000 });
    const bash = tools.find((t) => t.spec.name === "bash");
    expect(bash?.spec.description).toContain("max 10800s");
  });

  it("declares each tool's static side-effect capability (ADR-0024 / §4.8)", () => {
    const tools = createCoreTools(new Workspace(root), session);
    expect(tools.map((t) => [t.spec.name, t.staticCapability])).toEqual([
      ["read", { toolName: "read", effectEnvelope: ["fs_read"], broad: false }],
      ["write", { toolName: "write", effectEnvelope: ["fs_write"], broad: false }],
      ["edit", { toolName: "edit", effectEnvelope: ["fs_read", "fs_write"], broad: false }],
      [
        "bash",
        {
          toolName: "bash",
          effectEnvelope: ["fs_read", "fs_write", "network_read", "network_write", "process_exec"],
          broad: true,
        },
      ],
      ["search", { toolName: "search", effectEnvelope: ["fs_read"], broad: false }],
    ]);
  });

  it("registers the assembled tools so they are callable end-to-end via the executor", async () => {
    writeFileSync(join(root, "a.txt"), "hello world");
    const exec = new LocalExecutor();
    const tools = createCoreTools(new Workspace(root), session);
    registerCoreTools(exec, tools);
    expect(coreToolSpecs(tools)).toHaveLength(5);
    expect(await exec.execute({ id: "1", name: "read", args: { path: "a.txt" } })).toEqual({
      ok: true,
      output: "hello world",
    });
    const bash = await exec.execute({ id: "2", name: "bash", args: { command: "echo wired" } });
    expect(bash).toEqual({ ok: true, output: "wired" });
  });
});
