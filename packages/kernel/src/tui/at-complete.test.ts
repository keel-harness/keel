import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { completePath, completionTrustGate, type DirEntry } from "./at-complete.js";

/** A fake directory entry. */
const entry = (name: string, dir = false): DirEntry => ({ name, isDirectory: () => dir });

/** A fake workspace `/ws` with a few files + a `secret/` subtree + a `.git`. `readdir` returns a fixed
 *  listing per directory; `realpath` is identity (no symlinks) unless a test overrides it. */
const WS = "/ws";
const LISTING: Record<string, DirEntry[]> = {
  "/ws": [entry("src", true), entry("README.md"), entry("package.json"), entry(".git", true)],
  "/ws/src": [entry("index.ts"), entry("input.ts"), entry("util", true)],
};
const fakeReaddir = (dir: string): DirEntry[] => LISTING[dir] ?? [];
const trusted = () => "trusted" as const;
const untrusted = () => "untrusted" as const;
const identityRealpath = (p: string): string => p;

const base = { cwd: WS, readdir: fakeReaddir, realpath: identityRealpath };

/** Real temp dirs created by the fs-defaults test, removed afterwards. */
const cleanups: string[] = [];
afterAll(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
});

describe("completePath — @file path completion (Epic 1.23 slice 5, SEC-012)", () => {
  it("honors explicit per-run trust without persisting it, otherwise delegates to the trust store", () => {
    const persisted = vi.fn(() => "untrusted" as const);
    const readdir = vi.fn(fakeReaddir);
    const explicitGate = completionTrustGate(true, persisted);
    const persistedGate = completionTrustGate(false, persisted);

    expect(explicitGate(WS, {})).toBe("trusted");
    expect(persisted).not.toHaveBeenCalled();
    expect(completePath("src/", { ...base, trust: explicitGate })).toContain("src/index.ts");

    expect(completePath("src/", { ...base, readdir, trust: persistedGate })).toEqual([]);
    expect(persisted).toHaveBeenCalledOnce();
    expect(readdir).not.toHaveBeenCalled();
  });

  it("DENIED-PATH: an untrusted workspace returns [] and performs ZERO workspace reads", () => {
    const readdir = vi.fn(fakeReaddir);
    const out = completePath("src/", { ...base, readdir, trust: untrusted });
    expect(out).toEqual([]);
    expect(readdir).not.toHaveBeenCalled(); // no project file is listed before the human grants trust
  });

  it("an undecided workspace (no trust record) also returns [] with zero reads (fail-closed)", () => {
    const readdir = vi.fn(fakeReaddir);
    const out = completePath("", { ...base, readdir, trust: () => undefined });
    expect(out).toEqual([]);
    expect(readdir).not.toHaveBeenCalled();
  });

  it("lists the workspace root for an empty query (trusted), dirs marked with a trailing slash", () => {
    const out = completePath("", { ...base, trust: trusted });
    expect(out).toContain("src/");
    expect(out).toContain("README.md");
    expect(out).toContain("package.json");
  });

  it("filters by the basename prefix within a subdirectory", () => {
    const out = completePath("src/in", { ...base, trust: trusted });
    expect(out).toEqual(["src/index.ts", "src/input.ts"]);
  });

  it("hides dotfiles unless the prefix asks for them", () => {
    expect(completePath("", { ...base, trust: trusted })).not.toContain(".git/");
    expect(completePath(".", { ...base, trust: trusted })).toContain(".git/");
  });

  it("a '../' escape query yields [] (lexical containment — never lists outside the workspace)", () => {
    const readdir = vi.fn(fakeReaddir);
    const out = completePath("../etc/", { ...base, readdir, trust: trusted });
    expect(out).toEqual([]);
  });

  it("excludes an entry whose realpath escapes the workspace (symlink-escape)", () => {
    // `src/util` realpaths OUT of the workspace → containment must drop it.
    const realpath = (p: string): string => (p === "/ws/src/util" ? "/elsewhere/util" : p);
    const out = completePath("src/", { ...base, realpath, trust: trusted });
    expect(out).toContain("src/index.ts");
    expect(out).not.toContain("src/util/"); // the escaping symlink is excluded
  });

  it("excludes the keelHome config dir even when it sits inside the workspace (deniedRoots)", () => {
    // keelHome = /ws/.keel; an entry resolving into it must be denied.
    const listing: Record<string, DirEntry[]> = {
      "/ws": [entry(".keel", true), entry("README.md")],
    };
    const out = completePath("", {
      cwd: WS,
      readdir: (d) => listing[d] ?? [],
      realpath: identityRealpath,
      trust: trusted,
      env: { KEEL_HOME: "/ws/.keel" },
    });
    expect(out).toContain("README.md");
    expect(out).not.toContain(".keel/"); // the protected config dir is never offered
  });

  it("ER-020: sanitizes control bytes out of a candidate filename (a trusted repo can be hostile)", () => {
    // a file whose NAME carries an OSC-8 hyperlink + a BEL + a U+2028 (legal on Unix) — the candidate
    // is INSERTED INTO THE BUFFER on Tab, so it must be stripped at this data boundary, not just shown.
    const evil = `f\x1b]8;;http://evil\x07x\u2028g.ts`; // OSC-8 + BEL + U+2028 in a filename
    const out = completePath("f", {
      cwd: WS,
      readdir: () => [entry(evil)],
      realpath: identityRealpath,
      trust: trusted,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.includes("\x1b")).toBe(false); // ESC (OSC introducer) gone
    expect(out[0]!.includes("\x07")).toBe(false); // BEL gone
    expect(out[0]!.includes("\u2028")).toBe(false); // line separator collapsed (no row-forgery)
  });

  it("an unreadable directory yields [] (fail-closed, never throws)", () => {
    const out = completePath("nope/", {
      ...base,
      readdir: () => {
        throw new Error("EACCES");
      },
      trust: trusted,
    });
    expect(out).toEqual([]);
  });

  it("uses the real fs defaults (readdir + realpath) against a real workspace when trusted", () => {
    // Exercises the default `readdirSync`/`realpathSync` paths (no readdir/realpath injected) on a real
    // temp dir — proving the production code path, not just the injected fakes.
    const ws = mkdtempSync(join(tmpdir(), "keel-at-complete-"));
    cleanups.push(ws);
    writeFileSync(join(ws, "alpha.ts"), "");
    writeFileSync(join(ws, "beta.md"), "");
    mkdirSync(join(ws, "lib"));
    const out = completePath("", {
      cwd: ws,
      trust: trusted,
      env: { KEEL_HOME: join(ws, ".keel") },
    });
    expect(out).toContain("alpha.ts");
    expect(out).toContain("beta.md");
    expect(out).toContain("lib/");
  });

  it("caps the candidate list (calm overlay, no wall of files)", () => {
    const many = Array.from({ length: 100 }, (_, i) => entry(`f${i}.ts`));
    const out = completePath("", {
      cwd: WS,
      readdir: () => many,
      realpath: identityRealpath,
      trust: trusted,
    });
    expect(out.length).toBeLessThanOrEqual(20);
  });
});
