import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor } from "../local-executor.js";
import { Workspace } from "./workspace.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createToolRuntime } from "../cli/runtime.js";

/**
 * Config-dir guard (§3.2(6), Epic 1.9): the typed tools refuse the keel config dir even when asked —
 * an in-process Phase-1 guard at the Workspace path chokepoint (the OS-sandbox deny-read is Phase 2;
 * `bash` stays unsandboxed in P1, an honest DOC-LIMIT).
 */
describe("Workspace deniedRoots — refuse a protected dir inside the workspace", () => {
  it("denies a path inside a denied root, while normal workspace paths still resolve", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-cg-"));
    const cfg = join(root, "keelcfg");
    mkdirSync(cfg);
    mkdirSync(join(root, "src"));
    const ws = new Workspace(root, { deniedRoots: [cfg] });

    const denied = ws.resolve("keelcfg/trust.json");
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.denial.code).toBe("denied-path");

    expect(ws.resolve("src/app.ts").ok).toBe(true); // unaffected
  });

  it("resolveLexical (the followSymlink path) ALSO refuses a denied root (no bypass)", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-cglex-"));
    const cfg = join(root, "keelcfg");
    mkdirSync(cfg);
    const ws = new Workspace(root, { deniedRoots: [cfg] });
    const r = ws.resolveLexical("keelcfg/trust.json");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.denial.code).toBe("denied-path");
  });

  it("resolveLexical refuses an in-workspace SYMLINK whose target is the denied root (SEC-5)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-cgsymlex-")));
    const cfg = join(root, "keelcfg");
    mkdirSync(cfg);
    symlinkSync(cfg, join(root, "link")); // an in-workspace symlink pointing at the config dir
    const ws = new Workspace(root, { deniedRoots: [cfg] });
    // Lexically `link/trust.json` is inside the workspace and NOT inside `keelcfg`; only resolving the
    // real target reveals it lands in the denied root. The lexical-only guard let this through.
    const r = ws.resolveLexical("link/trust.json");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.denial.code).toBe("denied-path");
  });

  it("resolveLexical refuses a symlink to a denied root that sits OUTSIDE the workspace (default deploy)", () => {
    // The real default: keelHome (`~/.config/keel`) is outside the workspace. A repo symlink pointing
    // at it, read with --followSymlink, must still be refused — the denied root must survive the
    // strict-descendant filter so the realpath check can catch it.
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keel-cgout-")));
    const root = join(base, "ws");
    const cfg = join(base, "cfg"); // sibling of the workspace, OUTSIDE it
    mkdirSync(root);
    mkdirSync(cfg);
    symlinkSync(cfg, join(root, "creds-link"));
    const ws = new Workspace(root, { deniedRoots: [cfg] });
    const r = ws.resolveLexical("creds-link/credentials.json");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.denial.code).toBe("denied-path");
  });

  it("resolveLexical fails CLOSED (unresolvable) when the real target can't be resolved + denied roots exist", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-cgfc-")));
    const cfg = join(root, "keelcfg");
    mkdirSync(cfg);
    // A realpath that faults (EACCES) on the target but resolves the root/denied-root for construction.
    const realpath = (p: string): string => {
      if (p.includes("boom")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return realpathSync(p);
    };
    const ws = new Workspace(root, { deniedRoots: [cfg], realpath });
    const r = ws.resolveLexical("boom/x.txt");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.denial.code).toBe("unresolvable"); // never an unverified allow
  });

  it("the `read` tool with followSymlink:true refuses a symlink that targets the config dir (SEC-5)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-cgsym2-")));
    const cfg = join(root, "keelcfg");
    mkdirSync(cfg);
    writeFileSync(join(cfg, "credentials.json"), '{"anthropic":"sk-ant-secret"}');
    symlinkSync(cfg, join(root, "link"));
    const ws = new Workspace(root, { deniedRoots: [cfg] });
    const tool = createReadTool(ws);
    const exec = new LocalExecutor();
    exec.register(tool.spec.name, tool.handler);
    const r = await exec.execute({
      name: "read",
      args: { path: "link/credentials.json", followSymlink: true },
      id: "c1",
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/protected|config|off-limits/i);
  });

  it("the `write` tool refuses to write INTO a denied root (config-dir integrity, FS-4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-cgw-"));
    const cfg = join(root, "keelcfg");
    mkdirSync(cfg);
    writeFileSync(join(cfg, "trust.json"), '{"existing":"value"}'); // a real, pre-existing config file
    const ws = new Workspace(root, { deniedRoots: [cfg] });
    const tool = createWriteTool(ws);
    const exec = new LocalExecutor();
    exec.register(tool.spec.name, tool.handler);
    // Overwriting keel's own trust state is the high-risk INTEGRITY direction — it must be refused even
    // when explicitly asked, and the file must be byte-unchanged.
    const r = await exec.execute({
      name: "write",
      args: { path: "keelcfg/trust.json", content: '{"workspaces":{"/evil":"trusted"}}' },
      id: "c1",
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/protected|config|off-limits/i);
    expect(readFileSync(join(cfg, "trust.json"), "utf8")).toBe('{"existing":"value"}'); // untouched
  });

  it("the `write` tool refuses an in-workspace SYMLINK whose real target is the denied root (FS-4)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-cgwsym-")));
    const cfg = join(root, "keelcfg");
    mkdirSync(cfg);
    symlinkSync(cfg, join(root, "link")); // in-workspace symlink → config dir
    const ws = new Workspace(root, { deniedRoots: [cfg] });
    const tool = createWriteTool(ws);
    const exec = new LocalExecutor();
    exec.register(tool.spec.name, tool.handler);
    const r = await exec.execute({
      name: "write",
      args: { path: "link/credentials.json", content: '{"anthropic":"sk-evil"}' },
      id: "c1",
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/protected|config|off-limits/i);
  });

  it("the `edit` tool refuses to edit a file inside a denied root even when explicitly asked (FS-4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-cge-"));
    const cfg = join(root, "keelcfg");
    mkdirSync(cfg);
    const original = '{"anthropic":"sk-ant-real"}';
    writeFileSync(join(cfg, "credentials.json"), original);
    const ws = new Workspace(root, { deniedRoots: [cfg] });
    const tool = createEditTool(ws);
    const exec = new LocalExecutor();
    exec.register(tool.spec.name, tool.handler);
    // The denial fires at path resolution, BEFORE the read-before-edit/staleness logic — so editing a
    // protected file is refused regardless of whether it was "read".
    const r = await exec.execute({
      name: "edit",
      args: { path: "keelcfg/credentials.json", oldString: "sk-ant-real", newString: "sk-evil" },
      id: "c1",
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/protected|config|off-limits/i);
    expect(readFileSync(join(cfg, "credentials.json"), "utf8")).toBe(original); // untouched
  });

  it("the `read` tool refuses a file inside a denied root even when explicitly asked", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-cg2-"));
    const cfg = join(root, "keelcfg");
    mkdirSync(cfg);
    writeFileSync(join(cfg, "trust.json"), '{"secret":"x"}');
    const ws = new Workspace(root, { deniedRoots: [cfg] });
    const tool = createReadTool(ws);
    const exec = new LocalExecutor();
    exec.register(tool.spec.name, tool.handler);

    const r = await exec.execute({ name: "read", args: { path: "keelcfg/trust.json" }, id: "c1" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/protected|config|off-limits/i);
  });

  it("the `read` tool refuses the config dir even with followSymlink: true (S-2, no bypass)", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-cgsym-"));
    const cfg = join(root, "keelcfg");
    mkdirSync(cfg);
    writeFileSync(join(cfg, "trust.json"), '{"secret":"x"}');
    const ws = new Workspace(root, { deniedRoots: [cfg] });
    const tool = createReadTool(ws);
    const exec = new LocalExecutor();
    exec.register(tool.spec.name, tool.handler);
    const r = await exec.execute({
      name: "read",
      args: { path: "keelcfg/trust.json", followSymlink: true },
      id: "c1",
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/protected|config|off-limits/i);
  });
});

describe("createToolRuntime wires keelHome as a denied root (config-dir guard)", () => {
  it("the read tool refuses the keel config dir when keelHome is inside the workspace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-cg3-"));
    const home = join(cwd, "dotconfig");
    mkdirSync(home);
    writeFileSync(join(home, "trust.json"), '{"x":1}');
    const rt = createToolRuntime({ cwd, env: { KEEL_HOME: home } });
    try {
      const r = await rt.executor.execute({
        name: "read",
        args: { path: "dotconfig/trust.json" },
        id: "c1",
      });
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/protected|config|off-limits/i);
    } finally {
      await rt.dispose();
    }
  });
});
