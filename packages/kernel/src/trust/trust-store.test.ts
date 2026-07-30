import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTrustDecision, saveTrustDecision, trustFilePath } from "./trust-store.js";
import { withFileLock } from "../tools/file-lock.js";

/** A temp keelHome + a separate temp workspace; returns the env keyed to that keelHome. */
function fixture(): { home: string; ws: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), "keel-home-"));
  const ws = mkdtempSync(join(tmpdir(), "keel-ws-"));
  return { home, ws, env: { KEEL_HOME: home } };
}

describe("trust-store — the user-scope persisted workspace-trust decision (ADR-0017/0033)", () => {
  it("round-trips a decision keyed by the workspace root", () => {
    const { ws, env } = fixture();
    expect(loadTrustDecision(ws, env)).toBeUndefined(); // no record yet
    saveTrustDecision(ws, "trusted", env);
    expect(loadTrustDecision(ws, env)).toBe("trusted");
    saveTrustDecision(ws, "untrusted", env); // a later decision supersedes
    expect(loadTrustDecision(ws, env)).toBe("untrusted");
  });

  it("keeps decisions for different workspaces independent", () => {
    const { ws, env } = fixture();
    const ws2 = mkdtempSync(join(tmpdir(), "keel-ws2-"));
    saveTrustDecision(ws, "trusted", env);
    expect(loadTrustDecision(ws2, env)).toBeUndefined();
    saveTrustDecision(ws2, "untrusted", env);
    expect(loadTrustDecision(ws, env)).toBe("trusted"); // ws unchanged by ws2's decision
  });

  it("persists under keelHome (user scope), NEVER in the workspace (ADR-0033 — project-file scope)", () => {
    const { ws, home, env } = fixture();
    saveTrustDecision(ws, "trusted", env);
    expect(existsSync(trustFilePath(env))).toBe(true);
    expect(trustFilePath(env)).toBe(join(home, "trust.json"));
    expect(existsSync(join(ws, "trust.json"))).toBe(false); // nothing written into the workspace
    expect(existsSync(join(ws, ".keel"))).toBe(false);
  });

  it("fails SOFT on save: an unwritable keelHome does not throw (the run survives; nothing persisted)", () => {
    // keelHome sits under a *file*, so mkdir/write fail — save must swallow, not kill the session.
    const base = mkdtempSync(join(tmpdir(), "keel-ro-"));
    const blocker = join(base, "blocker");
    writeFileSync(blocker, "not a dir");
    const env: NodeJS.ProcessEnv = { KEEL_HOME: join(blocker, "keel") };
    expect(() => saveTrustDecision("/ws", "trusted", env)).not.toThrow();
    expect(loadTrustDecision("/ws", env)).toBeUndefined(); // nothing persisted — re-decide next run
  });

  it("fails closed: a malformed trust file reads as NO record (re-decide), never a silent grant", () => {
    const { ws, env } = fixture();
    writeFileSync(trustFilePath(env), "{ this is not json");
    expect(loadTrustDecision(ws, env)).toBeUndefined();
  });

  it("fails closed: a schema-invalid trust file reads as NO record", () => {
    const { ws, env } = fixture();
    writeFileSync(trustFilePath(env), JSON.stringify({ version: 99, workspaces: "nope" }));
    expect(loadTrustDecision(ws, env)).toBeUndefined();
  });

  /** Read back the single persisted entry for `ws`. */
  function entryFor(ws: string, env: NodeJS.ProcessEnv): { principal: string; decidedAt: string } {
    const raw = JSON.parse(readFileSync(trustFilePath(env), "utf8")) as {
      workspaces: Record<string, { principal: string; decidedAt: string }>;
    };
    return Object.values(raw.workspaces)[0]!;
  }

  it("records the deciding principal (USER → LOGNAME → 'unknown') and an ISO decidedAt", () => {
    const { ws, home } = fixture();
    saveTrustDecision(ws, "trusted", { KEEL_HOME: home, USER: "ada" });
    expect(entryFor(ws, { KEEL_HOME: home }).principal).toBe("ada");
    expect(entryFor(ws, { KEEL_HOME: home }).decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    saveTrustDecision(ws, "trusted", { KEEL_HOME: home, LOGNAME: "grace" }); // no USER → LOGNAME
    expect(entryFor(ws, { KEEL_HOME: home }).principal).toBe("grace");

    saveTrustDecision(ws, "trusted", { KEEL_HOME: home }); // neither → "unknown"
    expect(entryFor(ws, { KEEL_HOME: home }).principal).toBe("unknown");
  });

  it("skips the write (fail-soft) while the store lock is held, never interleaving", () => {
    const { ws, env } = fixture();
    const path = trustFilePath(env);
    // Hold the lock as if another session is mid-write; the contended save must not interleave.
    withFileLock(path, () => saveTrustDecision(ws, "trusted", env));
    expect(existsSync(path)).toBe(false);
    // Uncontended, it persists normally.
    saveTrustDecision(ws, "trusted", env);
    expect(loadTrustDecision(ws, env)).toBe("trusted");
  });
});
