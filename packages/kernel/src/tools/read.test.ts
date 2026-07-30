import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PathLike, type Stats } from "node:fs";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObjectT } from "@keel/shared";
import { Workspace } from "./workspace.js";
import { ToolError } from "./errors.js";
import {
  READ_BINARY_SNIFF_BYTES,
  READ_MAX_FILE_BYTES,
  READ_MAX_LARGE_LINE_SCAN_BYTES,
  READ_MAX_OUTPUT_BYTES,
  SPEC as READ_SPEC,
  createReadTool,
} from "./read.js";

let root: string;
let outside: string;
const read = (ws: Workspace, args: JsonObjectT): string =>
  createReadTool(ws).handler(args) as string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keel-read-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "keel-out-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("read tool", () => {
  const hugeStatSync = (_path: PathLike): Stats =>
    ({ isDirectory: () => false, size: READ_MAX_FILE_BYTES + 1 }) as unknown as Stats;
  const readWithHugeStat = (ws: Workspace, args: JsonObjectT): string =>
    createReadTool(ws, { statSync: hugeStatSync }).handler(args) as string;

  it("advertises that it reads files, not directories", () => {
    expect(READ_SPEC.description).toMatch(/file/i);
    expect(READ_SPEC.description).toMatch(/not (?:a )?director/i);
    expect(READ_SPEC.description).toMatch(/director.{0,100}search.{0,80}filename/i);
  });

  it("reads a whole text file", () => {
    writeFileSync(join(root, "a.txt"), "line1\nline2\nline3");
    expect(read(new Workspace(root), { path: "a.txt" })).toBe("line1\nline2\nline3");
  });

  it("reads a 1-based offset/limit line slice", () => {
    writeFileSync(join(root, "a.txt"), "l1\nl2\nl3\nl4\nl5");
    expect(read(new Workspace(root), { path: "a.txt", offset: 2, limit: 2 })).toBe("l2\nl3");
  });

  it("accepts common start/start_line aliases for offset before strict validation", () => {
    writeFileSync(join(root, "a.txt"), "l1\nl2\nl3\nl4\nl5");
    expect(read(new Workspace(root), { path: "a.txt", start: 3, limit: 2 })).toBe("l3\nl4");
    expect(read(new Workspace(root), { path: "a.txt", start_line: 4 })).toBe("l4\nl5");
  });

  it("rejects conflicting read aliases and still rejects unrelated unknown args", () => {
    writeFileSync(join(root, "a.txt"), "l1\nl2\nl3");
    expect(() => read(new Workspace(root), { path: "a.txt", offset: 2, start: 3 })).toThrow(
      /conflicting/i,
    );
    expect(() => read(new Workspace(root), { path: "a.txt", startLine: 2 })).toThrow(ToolError);
  });

  it("returns a note when offset is past EOF", () => {
    writeFileSync(join(root, "a.txt"), "only\n");
    expect(read(new Workspace(root), { path: "a.txt", offset: 99 })).toContain("past end of file");
  });

  it("truncates an over-long single line on a UTF-8 codepoint boundary (no replacement char)", () => {
    // One line of 3-byte '€' chars exceeding the output cap; a naive byte cut lands mid-codepoint.
    const line = "€".repeat(Math.ceil(READ_MAX_OUTPUT_BYTES / 3) + 100);
    writeFileSync(join(root, "big.txt"), line);
    const out = read(new Workspace(root), { path: "big.txt" });
    expect(out).toContain("line truncated");
    expect(out).not.toContain("�"); // no U+FFFD from a severed multibyte sequence
  });

  it("reads an empty file as empty string", () => {
    writeFileSync(join(root, "empty.txt"), "");
    expect(read(new Workspace(root), { path: "empty.txt" })).toBe("");
  });

  it("refuses a binary file (NUL byte) with guidance", () => {
    writeFileSync(join(root, "b.bin"), Buffer.from([0x41, 0x00, 0x42]));
    expect(() => read(new Workspace(root), { path: "b.bin" })).toThrow(/binary/i);
  });

  it("refuses a whole-file read when the NUL byte appears after the initial sniff window", () => {
    writeFileSync(
      join(root, "late-nul.bin"),
      Buffer.concat([Buffer.from("a".repeat(READ_BINARY_SNIFF_BYTES)), Buffer.from([0])]),
    );

    expect(() => read(new Workspace(root), { path: "late-nul.bin" })).toThrow(/binary/i);
  });

  it("refuses malformed UTF-8 on whole-file reads instead of replacement decoding", () => {
    writeFileSync(join(root, "bad-utf8.txt"), Buffer.from([0xc3]));
    expect(() => read(new Workspace(root), { path: "bad-utf8.txt" })).toThrow(
      /not complete UTF-8/i,
    );
  });

  it("refuses a directory", () => {
    writeFileSync(join(root, "keep"), "x");
    expect(() => read(new Workspace(root), { path: "." })).toThrow(ToolError);
  });

  it("gives clean guidance (not a raw errno) when a parent path component is a file", () => {
    writeFileSync(join(root, "f"), "x");
    expect(() => read(new Workspace(root), { path: "f/child.txt" })).toThrow(
      /parent path component|not a directory/i,
    );
  });

  it("refuses a non-existent file with ENOENT guidance", () => {
    expect(() => read(new Workspace(root), { path: "nope.txt" })).toThrow(/does not exist/);
  });

  it("refuses a multi-line range over the output cap; narrowing is the remedy", () => {
    // Many short lines whose joined size exceeds the cap.
    const line = "x".repeat(80);
    const n = Math.ceil(READ_MAX_OUTPUT_BYTES / (line.length + 1)) + 5;
    writeFileSync(join(root, "big.txt"), Array.from({ length: n }, () => line).join("\n"));
    expect(() => read(new Workspace(root), { path: "big.txt" })).toThrow(/too large|narrow/i);
  });

  it("fails closed when a whole-file read grows beyond the cap after stat", () => {
    writeFileSync(join(root, "race.txt"), Buffer.alloc(READ_MAX_FILE_BYTES + 1, 0x78));
    const staleSmallStat = () => ({ isDirectory: () => false, size: 1 }) as unknown as Stats;
    expect(() =>
      createReadTool(new Workspace(root), { statSync: staleSmallStat }).handler({
        path: "race.txt",
      }),
    ).toThrow(/grew beyond|too large/i);
  });

  it("truncates a single line that alone exceeds the output cap (with a notice)", () => {
    writeFileSync(join(root, "oneline.txt"), "y".repeat(READ_MAX_OUTPUT_BYTES + 500));
    const out = read(new Workspace(root), { path: "oneline.txt" });
    expect(out).toContain("[line truncated");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(READ_MAX_OUTPUT_BYTES + 200);
  });

  it("refuses an out-of-workspace symlink by default", () => {
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    let caught: unknown;
    try {
      read(new Workspace(root), { path: "link.txt" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as Error).message).toMatch(/outside the workspace/);
  });

  it("follows an out-of-workspace symlink only with followSymlink:true", () => {
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    expect(read(new Workspace(root), { path: "link.txt", followSymlink: true })).toBe("TOPSECRET");
  });

  it("rejects bad args (missing path) with a ToolError", () => {
    expect(() => read(new Workspace(root), {})).toThrow(ToolError);
  });

  it("refuses a file that exceeds the hard file-size ceiling", () => {
    writeFileSync(join(root, "huge.txt"), "small");
    const fakeStatSync = (_path: PathLike): Stats =>
      ({ isDirectory: () => false, size: READ_MAX_FILE_BYTES + 1 }) as unknown as Stats;
    const readWithFakeStat = (ws: Workspace, args: JsonObjectT): string =>
      createReadTool(ws, { statSync: fakeStatSync }).handler(args) as string;
    expect(() => readWithFakeStat(new Workspace(root), { path: "huge.txt" })).toThrow(/too large/);
  });

  it("allows bounded line slices of files larger than the whole-file ceiling", () => {
    const filler = "x".repeat(1024);
    const lines = ["header", ...Array.from({ length: 8200 }, () => filler), "TARGET", "tail"];
    writeFileSync(join(root, "huge.log"), lines.join("\n"));

    const out = read(new Workspace(root), { path: "huge.log", offset: 8202, limit: 1 });

    expect(out).toBe("TARGET");
    expect(read(new Workspace(root), { path: "huge.log", limit: 1 })).toBe("header");
    expect(() => read(new Workspace(root), { path: "huge.log", offset: 8202 })).toThrow(
      /too large|offset\/limit|narrow/i,
    );
  });

  it("allows bounded byte slices of huge UTF-8 text files without whole-file access", () => {
    const prefix = Buffer.from("prefix\n");
    const filler = Buffer.from("x".repeat(READ_MAX_FILE_BYTES + 1));
    const target = Buffer.from("needle\n");
    writeFileSync(join(root, "huge-bytes.log"), Buffer.concat([prefix, filler, target]));

    const out = read(new Workspace(root), {
      path: "huge-bytes.log",
      byteOffset: prefix.length + filler.length,
      byteLimit: target.length,
    });

    expect(out).toBe("needle\n");
  });

  it("validates byte-slice arguments before reading", () => {
    writeFileSync(join(root, "a.txt"), "abcdef");

    expect(() => read(new Workspace(root), { path: "a.txt", byteOffset: 1 })).toThrow(
      /byteOffset and byteLimit/i,
    );
    expect(() =>
      read(new Workspace(root), { path: "a.txt", byteOffset: 1, byteLimit: 2, offset: 1 }),
    ).toThrow(/cannot be combined/i);
    expect(() =>
      read(new Workspace(root), {
        path: "a.txt",
        byteOffset: 0,
        byteLimit: READ_MAX_OUTPUT_BYTES + 1,
      }),
    ).toThrow(/byteLimit is too large/i);
  });

  it("bounds byte-slice EOF, binary, and UTF-8 failures honestly", () => {
    writeFileSync(join(root, "a.txt"), "abcdef");
    expect(read(new Workspace(root), { path: "a.txt", byteOffset: 999, byteLimit: 1 })).toContain(
      "past end of file",
    );

    writeFileSync(join(root, "binary.bin"), Buffer.from([0x41, 0x00, 0x42]));
    expect(() =>
      read(new Workspace(root), { path: "binary.bin", byteOffset: 0, byteLimit: 3 }),
    ).toThrow(/binary/i);

    writeFileSync(
      join(root, "late-nul.bin"),
      Buffer.concat([Buffer.from("x".repeat(READ_BINARY_SNIFF_BYTES + 1)), Buffer.from([0])]),
    );
    expect(() =>
      read(new Workspace(root), {
        path: "late-nul.bin",
        byteOffset: 0,
        byteLimit: READ_BINARY_SNIFF_BYTES + 2,
      }),
    ).toThrow(/binary/i);

    writeFileSync(join(root, "bad-utf8.txt"), Buffer.from([0xc3]));
    expect(() =>
      read(new Workspace(root), { path: "bad-utf8.txt", byteOffset: 0, byteLimit: 1 }),
    ).toThrow(/not complete UTF-8/i);
  });

  it("bounds large-file line-slice edge cases without marking whole-file reads", () => {
    writeFileSync(join(root, "few-lines.log"), "one\ntwo");
    expect(
      readWithHugeStat(new Workspace(root), { path: "few-lines.log", offset: 99, limit: 1 }),
    ).toContain("past end of file");

    writeFileSync(join(root, "wide-range.log"), `${"a".repeat(40_000)}\n${"b".repeat(40_000)}`);
    expect(() =>
      readWithHugeStat(new Workspace(root), { path: "wide-range.log", offset: 1, limit: 2 }),
    ).toThrow(/selected range is too large/i);

    writeFileSync(join(root, "wide-line.log"), "z".repeat(READ_MAX_OUTPUT_BYTES + 500));
    expect(
      readWithHugeStat(new Workspace(root), { path: "wide-line.log", offset: 1, limit: 1 }),
    ).toContain("line truncated");
  });

  it("refuses deep large-file line slices after a bounded scan budget", () => {
    writeFileSync(join(root, "deep.log"), "x".repeat(READ_MAX_LARGE_LINE_SCAN_BYTES + 1024));

    expect(() => read(new Workspace(root), { path: "deep.log", offset: 2, limit: 1 })).toThrow(
      /line slice scan exceeded|byteOffset\/byteLimit/i,
    );
  });

  it("refuses binary and invalid UTF-8 large-file line slices", () => {
    writeFileSync(join(root, "huge-binary.log"), Buffer.from([0x41, 0x00, 0x42]));
    expect(() =>
      readWithHugeStat(new Workspace(root), { path: "huge-binary.log", offset: 1, limit: 1 }),
    ).toThrow(/binary/i);

    writeFileSync(join(root, "huge-bad-utf8.log"), Buffer.from([0xc3]));
    expect(() =>
      readWithHugeStat(new Workspace(root), { path: "huge-bad-utf8.log", offset: 1, limit: 1 }),
    ).toThrow(/not complete UTF-8/i);
  });

  it("returns EACCES guidance when statSync throws EACCES", () => {
    writeFileSync(join(root, "secret.txt"), "x");
    const fakeStatSync = (_path: PathLike): Stats => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    const readWithFakeStat = (ws: Workspace, args: JsonObjectT): string =>
      createReadTool(ws, { statSync: fakeStatSync }).handler(args) as string;
    expect(() => readWithFakeStat(new Workspace(root), { path: "secret.txt" })).toThrow(
      /permission denied/,
    );
  });

  it("returns generic guidance for an unknown fs error code", () => {
    writeFileSync(join(root, "weird.txt"), "x");
    const fakeStatSync = (_path: PathLike): Stats => {
      throw Object.assign(new Error("something weird"), { code: "EUNKNOWN" });
    };
    const readWithFakeStat = (ws: Workspace, args: JsonObjectT): string =>
      createReadTool(ws, { statSync: fakeStatSync }).handler(args) as string;
    expect(() => readWithFakeStat(new Workspace(root), { path: "weird.txt" })).toThrow(
      /something weird/,
    );
  });
});
