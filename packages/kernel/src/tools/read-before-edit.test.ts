import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObjectT } from "@keel/shared";
import { Workspace } from "./workspace.js";
import { ToolError } from "./errors.js";
import { FileAccessTracker } from "./file-access.js";
import { READ_MAX_FILE_BYTES, createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";

let root: string;
const file = (name: string, content: string): void => writeFileSync(join(root, name), content);

/** A read/write/edit trio sharing one per-session access tracker (the production wiring). */
function tools(tracker: FileAccessTracker): {
  read: (args: JsonObjectT) => string;
  write: (args: JsonObjectT) => string;
  edit: (args: JsonObjectT) => string;
} {
  const ws = new Workspace(root);
  return {
    read: (a) => createReadTool(ws, { tracker }).handler(a) as string,
    write: (a) => createWriteTool(ws, { tracker }).handler(a) as string,
    edit: (a) => createEditTool(ws, { tracker }).handler(a) as string,
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keel-rbe-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("read-before-edit invariant (§8.6) + resume-staleness (§4.7.10 / SEC-025)", () => {
  it("allows an edit after the file was read this session", () => {
    file("a.txt", "alpha BETA gamma");
    const t = tools(new FileAccessTracker());
    t.read({ path: "a.txt" });
    t.edit({ path: "a.txt", oldString: "BETA", newString: "delta" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha delta gamma");
  });

  it("refuses an edit outside the range read this session", () => {
    file("a.txt", "line one\nline two SECRET\nline three\n");
    const t = tools(new FileAccessTracker());
    expect(t.read({ path: "a.txt", offset: 1, limit: 1 })).toBe("line one");

    let err: unknown;
    try {
      t.edit({ path: "a.txt", oldString: "SECRET", newString: "redacted" });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toMatch(/read .*range|unread.*region/i);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(
      "line one\nline two SECRET\nline three\n",
    );
  });

  it("uses one generic partial-read edit denial for absent, duplicated, and off-range anchors", () => {
    file("a.txt", "visible line\nSECRET\nDUP DUP\n");
    const t = tools(new FileAccessTracker());
    expect(t.read({ path: "a.txt", offset: 1, limit: 1 })).toBe("visible line");

    const failures = ["MISSING", "SECRET", "DUP"].map((oldString) => {
      try {
        t.edit({ path: "a.txt", oldString, newString: "replacement" });
        return "unexpected success";
      } catch (err) {
        return (err as ToolError).message;
      }
    });

    expect(new Set(failures).size).toBe(1);
    expect(failures[0]).toMatch(/re-read the target range/i);
    expect(failures[0]).not.toMatch(/oldString not found|matches \d+|unread region|SECRET/i);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("visible line\nSECRET\nDUP DUP\n");
  });

  it("allows an edit inside a read range without upgrading unread regions", () => {
    file("a.txt", "line one\nline two SECRET\nline three OTHER\n");
    const t = tools(new FileAccessTracker());
    expect(t.read({ path: "a.txt", offset: 2, limit: 1 })).toBe("line two SECRET");
    t.edit({ path: "a.txt", oldString: "SECRET", newString: "redacted" });

    let err: unknown;
    try {
      t.edit({ path: "a.txt", oldString: "OTHER", newString: "hidden" });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toMatch(/read .*range|unread.*region/i);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(
      "line one\nline two redacted\nline three OTHER\n",
    );
  });

  it("keeps full-read coverage after a later small-file slice proves the file is unchanged", () => {
    file("a.txt", "line one\nline two SECRET\nline three\n");
    const t = tools(new FileAccessTracker());

    t.read({ path: "a.txt" });
    expect(t.read({ path: "a.txt", offset: 1, limit: 1 })).toBe("line one");
    expect(t.edit({ path: "a.txt", oldString: "SECRET", newString: "redacted" })).toBe(
      "edit: replaced 1 occurrence in 'a.txt'",
    );
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(
      "line one\nline two redacted\nline three\n",
    );
  });

  it("allows an edit inside a byte-slice read range, including non-ASCII text", () => {
    file("a.txt", "prefix\ncafe target\ncafé target\nsuffix\n");
    const t = tools(new FileAccessTracker());
    const target = "café target";
    const before = "prefix\ncafe target\n";
    expect(
      t.read({
        path: "a.txt",
        byteOffset: Buffer.byteLength(before, "utf8"),
        byteLimit: Buffer.byteLength(target, "utf8"),
      }),
    ).toBe(target);

    t.edit({ path: "a.txt", oldString: target, newString: "café redacted" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(
      "prefix\ncafe target\ncafé redacted\nsuffix\n",
    );
  });

  it("validates sliced edits against the current target range, not unrelated file drift", () => {
    file("a.txt", "prefix\nTARGET\nsuffix\n");
    const t = tools(new FileAccessTracker());
    const targetOffset = Buffer.byteLength("prefix\n", "utf8");
    expect(t.read({ path: "a.txt", byteOffset: targetOffset, byteLimit: "TARGET".length })).toBe(
      "TARGET",
    );

    file("a.txt", "changed outside\nTARGET\nsuffix\n");
    expect(() => t.edit({ path: "a.txt", oldString: "TARGET", newString: "redacted" })).toThrow(
      /target range/,
    );

    file("a.txt", "prefix\nTARGET\nchanged outside\n");
    expect(t.edit({ path: "a.txt", oldString: "TARGET", newString: "redacted" })).toBe(
      "edit: replaced 1 occurrence in 'a.txt'",
    );
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("prefix\nredacted\nchanged outside\n");
  });

  it("does not let a text byte slice authorize editing a binary file", () => {
    writeFileSync(join(root, "mixed.bin"), Buffer.from([0x00, 0x61, 0x62, 0x63]));
    const t = tools(new FileAccessTracker());

    expect(t.read({ path: "mixed.bin", byteOffset: 1, byteLimit: 3 })).toBe("abc");
    expect(() => t.edit({ path: "mixed.bin", oldString: "abc", newString: "def" })).toThrow(
      /binary file/,
    );
  });

  it("does not let a valid text byte slice authorize rewriting invalid UTF-8 bytes", () => {
    writeFileSync(join(root, "mixed.txt"), Buffer.from([0x61, 0x62, 0x63, 0xff]));
    const t = tools(new FileAccessTracker());

    expect(t.read({ path: "mixed.txt", byteOffset: 0, byteLimit: 3 })).toBe("abc");
    expect(() => t.edit({ path: "mixed.txt", oldString: "abc", newString: "def" })).toThrow(
      /not complete UTF-8/,
    );
    expect(readFileSync(join(root, "mixed.txt"))).toEqual(Buffer.from([0x61, 0x62, 0x63, 0xff]));
  });

  it("preserves a leading UTF-8 BOM across full read and edit", () => {
    writeFileSync(join(root, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63]));
    const t = tools(new FileAccessTracker());

    expect(t.read({ path: "bom.txt" })).toBe("\uFEFFabc");
    expect(t.edit({ path: "bom.txt", oldString: "\uFEFFabc", newString: "\uFEFFdef" })).toBe(
      "edit: replaced 1 occurrence in 'bom.txt'",
    );
    expect(readFileSync(join(root, "bom.txt"))).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf, 0x64, 0x65, 0x66]),
    );
  });

  it("allows an edit inside a large-file line-slice read range", () => {
    file("huge.log", "header\nTARGET\nfooter\n");
    const tracker = new FileAccessTracker();
    const ws = new Workspace(root);
    const read = (args: JsonObjectT): string =>
      createReadTool(ws, {
        tracker,
        statSync: () => ({ isDirectory: () => false, size: READ_MAX_FILE_BYTES + 1 }) as Stats,
      }).handler(args) as string;
    const edit = (args: JsonObjectT): string =>
      createEditTool(ws, { tracker }).handler(args) as string;

    expect(read({ path: "huge.log", offset: 2, limit: 1 })).toBe("TARGET");
    expect(edit({ path: "huge.log", oldString: "TARGET", newString: "redacted" })).toBe(
      "edit: replaced 1 occurrence in 'huge.log'",
    );
    expect(readFileSync(join(root, "huge.log"), "utf8")).toBe("header\nredacted\nfooter\n");
  });

  it("refuses an edit to a file not read this session, and does not modify it", () => {
    file("a.txt", "alpha BETA gamma");
    const t = tools(new FileAccessTracker());
    let err: unknown;
    try {
      t.edit({ path: "a.txt", oldString: "BETA", newString: "delta" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toMatch(/read .*before editing/i);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha BETA gamma"); // untouched
  });

  it("flags a file changed since its read as stale and refuses the edit until re-read (SEC-025)", () => {
    file("a.txt", "alpha BETA gamma");
    const t = tools(new FileAccessTracker());
    t.read({ path: "a.txt" });
    // an external mutation (a bash command, another process) — NOT through the tracked tools
    writeFileSync(join(root, "a.txt"), "alpha BETA gamma extra");

    let err: unknown;
    try {
      t.edit({ path: "a.txt", oldString: "BETA", newString: "delta" }); // anchor still matches
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toMatch(/changed .*since you read|stale/i);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha BETA gamma extra"); // not edited

    // re-reading clears the staleness (records the current signature) → the edit now proceeds
    t.read({ path: "a.txt" });
    t.edit({ path: "a.txt", oldString: "BETA", newString: "delta" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha delta gamma extra");
  });

  it("treats a file written this session as known, so write-then-edit is allowed", () => {
    const t = tools(new FileAccessTracker());
    t.write({ path: "b.txt", content: "hello world" });
    t.edit({ path: "b.txt", oldString: "world", newString: "there" });
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("hello there");
  });

  it("after an edit, a follow-up edit to the same file is allowed (the new content is known)", () => {
    file("a.txt", "one two three");
    const t = tools(new FileAccessTracker());
    t.read({ path: "a.txt" });
    t.edit({ path: "a.txt", oldString: "two", newString: "2" });
    t.edit({ path: "a.txt", oldString: "three", newString: "3" }); // no re-read needed
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one 2 3");
  });

  it("resume: a fresh session (new tracker) refuses an edit to a previously-read file until re-read", () => {
    file("a.txt", "alpha BETA gamma");
    tools(new FileAccessTracker()).read({ path: "a.txt" }); // prior session read

    const resumed = tools(new FileAccessTracker()); // resume = a brand-new, empty tracker
    expect(() => resumed.edit({ path: "a.txt", oldString: "BETA", newString: "delta" })).toThrow(
      /read .*before editing/i,
    );
    resumed.read({ path: "a.txt" }); // re-validate after resume
    resumed.edit({ path: "a.txt", oldString: "BETA", newString: "delta" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha delta gamma");
  });
});
