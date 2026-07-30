import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObjectT } from "@keel/shared";
import { Workspace } from "./workspace.js";
import { ToolError } from "./errors.js";
import { FileAccessTracker, contentHash } from "./file-access.js";
import { createWriteTool, type WriteToolDeps } from "./write.js";

let root: string;
let outside: string;
const write = (ws: Workspace, args: JsonObjectT, deps?: WriteToolDeps): string =>
  createWriteTool(ws, deps).handler(args) as string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keel-write-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "keel-out-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("write tool", () => {
  it("creates a new file and reports created + bytes", () => {
    const msg = write(new Workspace(root), { path: "a.txt", content: "hello" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello");
    expect(msg).toMatch(/created/);
    expect(msg).toContain("5");
  });

  it("creates parent directories", () => {
    write(new Workspace(root), { path: "x/y/z.txt", content: "deep" });
    expect(readFileSync(join(root, "x/y/z.txt"), "utf8")).toBe("deep");
  });

  it("overwrites an existing file and reports overwrote", () => {
    writeFileSync(join(root, "a.txt"), "old");
    const msg = write(new Workspace(root), { path: "a.txt", content: "new" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new");
    expect(msg).toMatch(/overwrote/);
  });

  it("refuses to write to an existing directory", () => {
    mkdirSync(join(root, "d"));
    expect(() => write(new Workspace(root), { path: "d", content: "x" })).toThrow(/director/i);
  });

  it("refuses when a parent path component is a file", () => {
    writeFileSync(join(root, "f"), "x");
    expect(() => write(new Workspace(root), { path: "f/child.txt", content: "x" })).toThrow(
      ToolError,
    );
  });

  it("refuses a symlink-escape target", () => {
    symlinkSync(outside, join(root, "link"));
    let caught: unknown;
    try {
      write(new Workspace(root), { path: "link/evil.txt", content: "x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as Error).message).toMatch(/outside the workspace/);
  });

  it("refuses a leaf symlink pointing to an existing file outside the workspace", () => {
    writeFileSync(join(outside, "x"), "o");
    symlinkSync(join(outside, "x"), join(root, "leaf"));
    let caught: unknown;
    try {
      write(new Workspace(root), { path: "leaf", content: "y" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as Error).message).toMatch(/outside the workspace/);
  });

  it("contains a dangling leaf symlink pointing outside (creates file in-place, no escape)", () => {
    // Dangling: the target outside does not exist yet.
    symlinkSync(join(outside, "ghost"), join(root, "dangling"));
    write(new Workspace(root), { path: "dangling", content: "z" });
    // The outside target must NOT have been created (no escape).
    expect(existsSync(join(outside, "ghost"))).toBe(false);
    // The symlink path in the workspace must now hold the written content.
    expect(readFileSync(join(root, "dangling"), "utf8")).toBe("z");
  });

  it("rejects bad args (missing content)", () => {
    expect(() => write(new Workspace(root), { path: "a.txt" })).toThrow(ToolError);
  });

  it("refuses NUL-bearing content before any mutation", () => {
    const target = join(root, "binary.txt");

    expect(() =>
      write(new Workspace(root), { path: "binary.txt", content: "alpha\0beta" }),
    ).toThrow(/NUL bytes|binary content/i);
    expect(existsSync(target)).toBe(false);
  });

  it("reports post-rename atomic failures as mutation-possible and forgets file evidence", () => {
    const target = join(root, "a.txt");
    writeFileSync(target, "ORIGINAL");
    const tracker = new FileAccessTracker();
    tracker.markKnown(target, contentHash("ORIGINAL"));
    let fsyncCalls = 0;

    expect(() =>
      write(
        new Workspace(root),
        { path: "a.txt", content: "NEW" },
        {
          tracker,
          fsyncSync: () => {
            fsyncCalls += 1;
            if (fsyncCalls === 2) throw new Error("directory fsync failed");
          },
        },
      ),
    ).toThrow(/target may have changed/i);
    expect(readFileSync(target, "utf8")).toBe("NEW");
    expect(tracker.hasKnownCoverage(target)).toBe(false);
  });

  describe("syntax-check gate", () => {
    it("rejects a write that introduces a syntax error and does NOT create the file", () => {
      const ws = new Workspace(root);
      expect(() => write(ws, { path: "broken.ts", content: "const x: = 1;" }, { env: {} })).toThrow(
        /syntax error/i,
      );
      expect(existsSync(join(root, "broken.ts"))).toBe(false);
    });

    it("writes a syntactically valid file normally", () => {
      const ws = new Workspace(root);
      const msg = write(ws, { path: "ok.ts", content: "export const x = 1;\n" }, { env: {} });
      expect(msg).toMatch(/created/);
      expect(readFileSync(join(root, "ok.ts"), "utf8")).toContain("export const x = 1;");
    });

    it("KEEL_NO_EDIT_CHECK=1 disables the gate (writes the broken file)", () => {
      const ws = new Workspace(root);
      const msg = write(
        ws,
        { path: "broken2.ts", content: "const x: = 1;" },
        { env: { KEEL_NO_EDIT_CHECK: "1" } },
      );
      expect(msg).toMatch(/created/);
      expect(existsSync(join(root, "broken2.ts"))).toBe(true);
    });
  });

  describe("injected-fs coverage (unreachable branches)", () => {
    const fakeStats = (isDir: boolean): Stats => ({ isDirectory: () => isDir }) as unknown as Stats;

    it("maps EACCES statSync error to permission-denied guidance", () => {
      const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
      expect(() =>
        write(
          new Workspace(root),
          { path: "a.txt", content: "x" },
          {
            statSync: () => {
              throw err;
            },
          },
        ),
      ).toThrow(/permission denied/i);
    });

    it("maps EPERM statSync error to permission-denied guidance", () => {
      const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
      expect(() =>
        write(
          new Workspace(root),
          { path: "a.txt", content: "x" },
          {
            statSync: () => {
              throw err;
            },
          },
        ),
      ).toThrow(/permission denied/i);
    });

    it("maps EISDIR statSync error to directory guidance", () => {
      const err = Object.assign(new Error("EISDIR"), { code: "EISDIR" });
      expect(() =>
        write(
          new Workspace(root),
          { path: "a.txt", content: "x" },
          {
            statSync: () => {
              throw err;
            },
          },
        ),
      ).toThrow(/director/i);
    });

    it("maps unknown statSync error code to generic guidance", () => {
      const err = Object.assign(new Error("EIO"), { code: "EIO" });
      expect(() =>
        write(
          new Workspace(root),
          { path: "a.txt", content: "x" },
          {
            statSync: () => {
              throw err;
            },
          },
        ),
      ).toThrow(/cannot write/i);
    });

    it("maps atomicWrite failure to ToolError with guidance", () => {
      const writeErr = Object.assign(new Error("EACCES"), { code: "EACCES" });
      expect(() =>
        write(
          new Workspace(root),
          { path: "a.txt", content: "x" },
          {
            statSync: () => fakeStats(false),
            writeFileSync: () => {
              throw writeErr;
            },
          },
        ),
      ).toThrow(/permission denied/i);
    });

    it("maps atomicWrite generic failure to ToolError", () => {
      const writeErr = Object.assign(new Error("boom"), { code: "EUNKNOWN" });
      expect(() =>
        write(
          new Workspace(root),
          { path: "a.txt", content: "x" },
          {
            statSync: () => fakeStats(false),
            writeFileSync: () => {
              throw writeErr;
            },
          },
        ),
      ).toThrow(/cannot write/i);
    });
  });
});
