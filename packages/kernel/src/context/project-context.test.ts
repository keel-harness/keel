import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectFs } from "./project-reader.js";
import { ProjectReader, defaultProjectFs } from "./project-reader.js";
import { gatherProjectContext, loadProjectContext } from "./project-context.js";
import { loadTrustDecision, saveTrustDecision } from "../trust/trust-store.js";

const sys = { cores: 8, memGB: 16 };

/** An isolated keelHome so the real trust store is never read from the dev machine. */
const home = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-pchome-")) });

function spyFs(seed: { dirs?: Record<string, string[]> }): ProjectFs & { calls: number } {
  const fs = {
    calls: 0,
    listDir: (p: string): string[] => {
      fs.calls++;
      return seed.dirs?.[p] ?? [];
    },
    readFile: (_p: string): string | undefined => {
      fs.calls++;
      return undefined;
    },
    probeVersion: (_t: string): string | undefined => {
      fs.calls++;
      return undefined;
    },
    realpath: (p: string): string | undefined => {
      fs.calls++;
      return p; // identity realpath for the spy
    },
  };
  return fs;
}

describe("loadProjectContext — gate the project context on trust", () => {
  it("untrusted reader → empty project context (no environment snapshot)", () => {
    const reader = new ProjectReader(spyFs({ dirs: { "/ws": ["src/"] } }), { trusted: false });
    expect(loadProjectContext(reader, "/ws", sys)).toEqual({ trusted: false });
  });

  it("trusted reader → an environment snapshot read THROUGH the gate", () => {
    const reader = new ProjectReader(spyFs({ dirs: { "/ws": ["src/", "package.json"] } }), {
      trusted: true,
    });
    const ctx = loadProjectContext(reader, "/ws", sys);
    expect(ctx.environment).toMatch(/# Environment/);
    expect(ctx.environment).toMatch(/\/ws/);
    expect(ctx.environment).toMatch(/package\.json/);
  });

  it("trusted reader → includes the workspace AGENTS.md as instructions", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-pc-agents-"));
    writeFileSync(join(dir, "AGENTS.md"), "always run pnpm test before claiming done");
    const ctx = loadProjectContext(
      new ProjectReader(defaultProjectFs(), { trusted: true }),
      dir,
      sys,
    );
    expect(ctx.instructions).toMatch(/always run pnpm test/);
    expect(ctx.environment).toMatch(/# Environment/);
  });

  it("untrusted reader → no instructions and no environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-pc-agents2-"));
    writeFileSync(join(dir, "AGENTS.md"), "rule");
    const ctx = loadProjectContext(
      new ProjectReader(defaultProjectFs(), { trusted: false }),
      dir,
      sys,
    );
    expect(ctx).toEqual({ trusted: false });
  });
});

describe("gatherProjectContext — resolve trust then load context (SEC-012 composition)", () => {
  it("non-interactive default (no opt-in): empty context AND zero real fs reads", async () => {
    const fs = spyFs({ dirs: { "/ws": ["package.json"] } });
    const ctx = await gatherProjectContext({ cwd: "/ws", env: home(), fs, sys });
    expect(ctx).toEqual({ trusted: false });
    expect(fs.calls).toBe(0); // trust-before-parse: nothing read before acceptance
  });

  it("a persisted 'trusted' decision loads context with no flag/env opt-in", async () => {
    const env = home();
    saveTrustDecision("/ws", "trusted", env); // a prior human decision, persisted user-scope
    const fs = spyFs({ dirs: { "/ws": ["package.json", "src/"] } });
    const ctx = await gatherProjectContext({ cwd: "/ws", env, fs, sys });
    expect(ctx.environment).toMatch(/package\.json/);
  });

  it("a persisted 'untrusted' decision keeps context empty even without an opt-in", async () => {
    const env = home();
    saveTrustDecision("/ws", "untrusted", env);
    const fs = spyFs({ dirs: { "/ws": ["package.json"] } });
    expect(await gatherProjectContext({ cwd: "/ws", env, fs, sys })).toEqual({ trusted: false });
    expect(fs.calls).toBe(0);
  });

  it("interactive accept: loads context and PERSISTS the decision for next time", async () => {
    const env = home();
    const fs = spyFs({ dirs: { "/ws": ["package.json"] } });
    const ctx = await gatherProjectContext({
      cwd: "/ws",
      env,
      fs,
      sys,
      isTTY: true,
      promptTrust: async () => true,
    });
    expect(ctx.environment).toMatch(/package\.json/);
    expect(loadTrustDecision("/ws", env)).toBe("trusted"); // persisted user-scope
  });

  it("interactive decline: empty context, zero reads, and the decline is PERSISTED", async () => {
    const env = home();
    const fs = spyFs({ dirs: { "/ws": ["package.json"] } });
    const ctx = await gatherProjectContext({
      cwd: "/ws",
      env,
      fs,
      sys,
      isTTY: true,
      promptTrust: async () => false,
    });
    expect(ctx).toEqual({ trusted: false });
    expect(fs.calls).toBe(0);
    expect(loadTrustDecision("/ws", env)).toBe("untrusted");
  });

  it("KEEL_TRUST=1: the environment snapshot loads through the real (spy) fs", async () => {
    const fs = spyFs({ dirs: { "/ws": ["package.json", "src/"] } });
    const ctx = await gatherProjectContext({ cwd: "/ws", env: { KEEL_TRUST: "1" }, fs, sys });
    expect(ctx.environment).toMatch(/package\.json/);
    expect(fs.calls).toBeGreaterThan(0);
  });

  it("uses the real default fs + system info when not injected; --trust opts in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-pc-"));
    writeFileSync(join(dir, "package.json"), "{}");
    const ctx = await gatherProjectContext({ cwd: dir, env: {}, trustFlag: true });
    expect(ctx.environment).toMatch(/package\.json/); // real fs read the temp dir
    expect(ctx.environment).toMatch(/cores/); // real systemInfo()
  });

  it("trusted: discovers skills from the injected built-in dir (stub list + registry, no body)", async () => {
    const builtinDir = mkdtempSync(join(tmpdir(), "keel-builtins-"));
    mkdirSync(join(builtinDir, "commit"));
    writeFileSync(
      join(builtinDir, "commit", "SKILL.md"),
      "---\nname: commit\ndescription: Use when committing\n---\nCOMMIT-BODY",
    );
    const cwd = mkdtempSync(join(tmpdir(), "keel-cwd-"));
    const ctx = await gatherProjectContext({
      cwd,
      env: { ...home(), KEEL_TRUST: "1" },
      sys,
      skillDirs: { builtinDir },
    });
    expect(ctx.skills).toMatch(/commit/);
    expect(ctx.skills).not.toMatch(/COMMIT-BODY/); // the body is NOT in the discovery context
    expect(ctx.skillRegistry?.loadBody("commit")).toBe("COMMIT-BODY"); // body loads on trigger
  });

  it("untrusted: no skills discovered even with a built-in dir (trust-before-parse)", async () => {
    const builtinDir = mkdtempSync(join(tmpdir(), "keel-builtins2-"));
    mkdirSync(join(builtinDir, "commit"));
    writeFileSync(
      join(builtinDir, "commit", "SKILL.md"),
      "---\nname: commit\ndescription: d\n---\nB",
    );
    const cwd = mkdtempSync(join(tmpdir(), "keel-cwd2-"));
    const ctx = await gatherProjectContext({ cwd, env: home(), sys, skillDirs: { builtinDir } });
    expect(ctx.skills).toBeUndefined();
    expect(ctx.skillRegistry).toBeUndefined();
  });
});
