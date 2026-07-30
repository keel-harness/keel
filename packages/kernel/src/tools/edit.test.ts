import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObjectT } from "@keel/shared";
import { Workspace } from "./workspace.js";
import { ToolError } from "./errors.js";
import { FileAccessTracker } from "./file-access.js";
import { createReadTool } from "./read.js";
import { createEditTool, type EditToolDeps } from "./edit.js";

let root: string;
const edit = (ws: Workspace, args: JsonObjectT, deps?: EditToolDeps): string =>
  createEditTool(ws, deps).handler(args) as string;
const file = (name: string, content: string): void => writeFileSync(join(root, name), content);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keel-edit-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("edit tool", () => {
  it("replaces a unique anchor", () => {
    file("a.txt", "alpha BETA gamma");
    edit(new Workspace(root), { path: "a.txt", oldString: "BETA", newString: "delta" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha delta gamma");
  });

  it("replaces exactly one occurrence even when newString re-introduces oldString", () => {
    file("a.txt", "x marks");
    edit(new Workspace(root), { path: "a.txt", oldString: "x", newString: "xx" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("xx marks"); // not re-scanned
  });

  it("refuses to edit files that contain NUL bytes", () => {
    writeFileSync(join(root, "mixed.bin"), Buffer.from([0x00, 0x61, 0x62, 0x63]));

    expect(() =>
      edit(new Workspace(root), { path: "mixed.bin", oldString: "abc", newString: "def" }),
    ).toThrow(/binary file/u);
  });

  it("refuses NUL-bearing replacement text without modifying the file", () => {
    file("a.txt", "alpha beta\n");

    expect(() =>
      edit(new Workspace(root), { path: "a.txt", oldString: "alpha", newString: "a\0z" }),
    ).toThrow(/NUL bytes|binary content/u);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha beta\n");
  });

  it("refuses when the anchor is absent (with a whitespace/line-ending hint)", () => {
    file("a.txt", "hello");
    expect(() =>
      edit(new Workspace(root), { path: "a.txt", oldString: "nope", newString: "x" }),
    ).toThrow(/not found/i);
  });

  it("not-found feedback includes a bounded nearest-line hint and next action", () => {
    file("a.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    let err: unknown;
    try {
      edit(new Workspace(root), {
        path: "a.ts",
        oldString: "\treturn a + b;",
        newString: "  return a - b;",
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ToolError);
    const message = (err as ToolError).message;
    expect(message).toContain("oldString not found");
    expect(message).toContain("Closest line 2");
    expect(message).toContain("return a + b;");
    expect(message).toContain("Re-read around that line");
    expect(message.length).toBeLessThan(360);
  });

  it("not-found feedback truncates long nearest-line previews", () => {
    const longLine = `const payload = "${"x".repeat(500)}";\n`;
    file("a.ts", longLine);
    let err: unknown;
    try {
      edit(new Workspace(root), {
        path: "a.ts",
        oldString: `const payload = "${"x".repeat(120)}y";`,
        newString: 'const payload = "short";',
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ToolError);
    const message = (err as ToolError).message;
    expect(message).toContain("Closest line 1");
    expect(message).toContain("...");
    expect(message).not.toContain("x".repeat(250));
    expect(message.length).toBeLessThan(420);
  });

  it("omits nearest-line hints for unrelated anchors", () => {
    file("a.txt", "hello world\n");
    let err: unknown;
    try {
      edit(new Workspace(root), {
        path: "a.txt",
        oldString: "completely unrelated target",
        newString: "replacement",
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ToolError);
    const message = (err as ToolError).message;
    expect(message).toContain("oldString not found");
    expect(message).toContain("Re-read the target region");
    expect(message).not.toContain("Closest line");
  });

  it("does not leak unread nearest-line hints after only a partial read", async () => {
    const tracker = new FileAccessTracker();
    const ws = new Workspace(root);
    file("secret.txt", "public line\nSECRET_TOKEN_DO_NOT_EXPOSE\n");
    await createReadTool(ws, { tracker }).handler({ path: "secret.txt", offset: 1, limit: 1 });

    let err: unknown;
    try {
      await createEditTool(ws, { tracker }).handler({
        path: "secret.txt",
        oldString: "SECRET_TOKEN_DO_NOT_EXPOSF",
        newString: "replacement",
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ToolError);
    const message = (err as ToolError).message;
    expect(message).not.toContain("oldString not found");
    expect(message).toMatch(/Re-read the target range/i);
    expect(message).not.toContain("Closest line");
    expect(message).not.toContain("SECRET_TOKEN_DO_NOT_EXPOSE");
  });

  it("refuses a non-unique anchor and reports the count", () => {
    file("a.txt", "dup dup dup");
    let err: unknown;
    try {
      edit(new Workspace(root), { path: "a.txt", oldString: "dup", newString: "x" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toMatch(/3 times|matches 3/);
  });

  it("rejects an empty oldString", () => {
    file("a.txt", "x");
    expect(() =>
      edit(new Workspace(root), { path: "a.txt", oldString: "", newString: "y" }),
    ).toThrow(ToolError);
  });

  it("rejects oldString === newString (no-op)", () => {
    file("a.txt", "x");
    expect(() =>
      edit(new Workspace(root), { path: "a.txt", oldString: "x", newString: "x" }),
    ).toThrow(ToolError);
  });

  it("gives clean guidance (not a raw errno) when a parent path component is a file", () => {
    file("f", "x");
    expect(() =>
      edit(new Workspace(root), { path: "f/child.txt", oldString: "a", newString: "b" }),
    ).toThrow(/parent path component|not a directory/i);
  });

  it("refuses editing a non-existent file", () => {
    expect(() =>
      edit(new Workspace(root), { path: "nope.txt", oldString: "a", newString: "b" }),
    ).toThrow(/does not exist/);
  });

  it("leaves the file byte-identical when the anchor is not unique (no partial write)", () => {
    file("a.txt", "dup dup");
    try {
      edit(new Workspace(root), { path: "a.txt", oldString: "dup", newString: "x" });
    } catch {
      /* expected */
    }
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("dup dup");
  });

  describe("injected-fs coverage (unreachable branches)", () => {
    it("maps non-ENOENT readFileSync error to ToolError", () => {
      const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
      expect(() =>
        edit(
          new Workspace(root),
          { path: "a.txt", oldString: "x", newString: "y" },
          {
            readFileSync: () => {
              throw err;
            },
          },
        ),
      ).toThrow(/cannot read/i);
    });

    it("maps atomicWrite failure to ToolError", () => {
      file("a.txt", "alpha BETA gamma");
      expect(() =>
        edit(
          new Workspace(root),
          { path: "a.txt", oldString: "BETA", newString: "delta" },
          {
            writeFileSync: () => {
              throw new Error("disk full");
            },
          },
        ),
      ).toThrow(/cannot write/i);
    });

    it("reports post-rename atomic failures as mutation-possible and forgets file evidence", async () => {
      file("a.txt", "alpha BETA gamma");
      const ws = new Workspace(root);
      const tracker = new FileAccessTracker();
      await createReadTool(ws, { tracker }).handler({ path: "a.txt" });
      let fsyncCalls = 0;

      expect(() =>
        edit(
          ws,
          { path: "a.txt", oldString: "BETA", newString: "delta" },
          {
            tracker,
            fsyncSync: () => {
              fsyncCalls += 1;
              if (fsyncCalls === 2) throw new Error("directory fsync failed");
            },
          },
        ),
      ).toThrow(/target may have changed/i);
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha delta gamma");
      expect(tracker.hasKnownCoverage(join(root, "a.txt"))).toBe(false);
    });

    it("refuses an outside-workspace path (containment denial)", () => {
      expect(() =>
        edit(new Workspace(root), { path: "../escape.txt", oldString: "x", newString: "y" }),
      ).toThrow(ToolError);
    });
  });

  describe("syntax-check gate", () => {
    it("rejects an edit that introduces a new syntax error; file + tracker unchanged (non-desync invariant)", async () => {
      const tracker = new FileAccessTracker();
      const ws = new Workspace(root);
      writeFileSync(join(root, "a.ts"), "export const x = 1;\n");
      // Satisfy read-before-edit so the tracker knows the file.
      await createReadTool(ws, { tracker }).handler({ path: "a.ts" });
      // An edit that introduces a syntax error (": ;" is invalid TS).
      let err: unknown;
      try {
        await createEditTool(ws, { tracker, env: {} }).handler({
          path: "a.ts",
          oldString: "1",
          newString: ": ;",
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).message).toMatch(/syntax error/i);
      // File must be byte-identical to the original.
      expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export const x = 1;\n");
      // Tracker must NOT have been mutated: a subsequent valid edit on the same file
      // succeeds WITHOUT a re-read, proving markKnown was not called on rejection.
      await createEditTool(ws, { tracker, env: {} }).handler({
        path: "a.ts",
        oldString: "1",
        newString: "2",
      });
      expect(readFileSync(join(root, "a.ts"), "utf8")).toContain("= 2;");
    });

    it("allows a valid edit (baseline clean)", async () => {
      const tracker = new FileAccessTracker();
      const ws = new Workspace(root);
      writeFileSync(join(root, "b.ts"), "export const x = 1;\n");
      await createReadTool(ws, { tracker }).handler({ path: "b.ts" });
      const result = await createEditTool(ws, { tracker, env: {} }).handler({
        path: "b.ts",
        oldString: "1",
        newString: "2",
      });
      expect(result).toMatch(/replaced/i);
      expect(readFileSync(join(root, "b.ts"), "utf8")).toContain("= 2;");
    });

    it("KEEL_NO_EDIT_CHECK=1 disables the gate for edit (writes broken syntax)", async () => {
      const tracker = new FileAccessTracker();
      const ws = new Workspace(root);
      writeFileSync(join(root, "c.ts"), "export const x = 1;\n");
      await createReadTool(ws, { tracker }).handler({ path: "c.ts" });
      const msg = await createEditTool(ws, { tracker, env: { KEEL_NO_EDIT_CHECK: "1" } }).handler({
        path: "c.ts",
        oldString: "1",
        newString: ": ;",
      });
      expect(msg).toMatch(/replaced/i);
      expect(readFileSync(join(root, "c.ts"), "utf8")).toContain(": ;");
    });
  });
});
