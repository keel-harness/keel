import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  closeSync as fsCloseSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  READ_MAX_FILE_BYTES,
  READ_MAX_LARGE_LINE_SCAN_BYTES,
  READ_MAX_OUTPUT_BYTES,
  READ_BINARY_SNIFF_BYTES,
  ReadArgs,
  SEARCH_MAX_LINE_BYTES,
  SEARCH_MAX_RAW_STDOUT_LINE_BYTES,
  SEARCH_MAX_STDERR_BYTES,
  SearchArgs,
  TypedToolError,
  createTypedToolState,
  executeEditTool,
  executeReadTool,
  executeSearchTool,
  executeWriteTool,
  parseEditArgs,
  parseReadArgs,
  parseSearchArgs,
  parseWriteArgs,
  prepareEditToolMutation,
  prepareWriteToolMutation,
  redactThenTruncateHeadTail,
  truncateHeadTail,
} from "./typed-tools.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("marks an atomic write failure after rename as mutation-possible", () => {
  const workspace = tempDir("keel-typed-write-partial-");
  const target = join(workspace, "changed.txt");
  let fsyncCalls = 0;

  let caught: unknown;
  try {
    executeWriteTool(
      { path: "changed.txt", content: "new content" },
      {
        workspaceRoot: workspace,
        fsyncSync: (fd) => {
          fsyncCalls += 1;
          if (fsyncCalls === 2) throw new Error("directory fsync failed");
          fsyncSync(fd);
        },
      },
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(TypedToolError);
  expect((caught as TypedToolError).mutationPossible).toBe(true);
  expect((caught as Error).message).toContain("target may have changed");
  expect(readFileSync(target, "utf8")).toBe("new content");
});

function statLike(options: { readonly size?: number; readonly directory?: boolean } = {}): Stats {
  return {
    size: options.size ?? 0,
    isDirectory: () => options.directory === true,
  } as Stats;
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function realpathThatMovesTargetAfterValidation(
  target: string,
  outsideTarget: string,
): (path: string) => string {
  const targetReal = realpathSync(target);
  const outsideReal = realpathSync(outsideTarget);
  let targetCalls = 0;
  return (path) => {
    const real = realpathSync(path);
    if (real === targetReal) {
      targetCalls += 1;
      return targetCalls === 1 ? targetReal : outsideReal;
    }
    return real;
  };
}

function throwNonError(value: unknown): never {
  throw value;
}

type FakeChild = ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    setImmediate(() => {
      child.emit("exit", null, signal);
      child.emit("close", null, signal);
    });
    return true;
  });
  return child;
}

function fakeSpawn(
  script: (child: FakeChild) => void,
  seen: { cmd?: string; args?: string[]; opts?: SpawnOptions } = {},
): (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess {
  return (cmd, args, opts) => {
    seen.cmd = cmd;
    seen.args = args;
    seen.opts = opts;
    const child = fakeChild();
    setImmediate(() => script(child));
    return child;
  };
}

describe("warden typed read tool", () => {
  it("parses read args and returns clean invalid-arg guidance", () => {
    expect(parseReadArgs({ path: "README.md", offset: 1, limit: 2 })).toEqual({
      path: "README.md",
      offset: 1,
      limit: 2,
    });
    expect(parseReadArgs({ path: "README.md", byteOffset: 4, byteLimit: 8 })).toEqual({
      path: "README.md",
      byteOffset: 4,
      byteLimit: 8,
    });

    expect(() => parseReadArgs({ offset: 1 })).toThrow(TypedToolError);
    try {
      parseReadArgs({ offset: 1 });
    } catch (error) {
      if (!(error instanceof TypedToolError)) throw error;
      expect(error.code).toBe("INVALID_PARAMS");
      expect(error.message).toContain("invalid 'path'");
    }
    expect(() => parseReadArgs({ path: "README.md", extra: true })).toThrow("invalid arguments");
    expect(() => parseReadArgs({ path: "README.md", followSymlink: true })).toThrow(
      /invalid arguments/u,
    );
    expect(() => parseReadArgs({ path: "README.md", byteOffset: 1 })).toThrow(
      /byteOffset and byteLimit/u,
    );
    expect(() =>
      parseReadArgs({ path: "README.md", byteOffset: 1, byteLimit: 2, offset: 1 }),
    ).toThrow(/cannot be combined/u);
    expect(() =>
      parseReadArgs({
        path: "README.md",
        byteOffset: 1,
        byteLimit: READ_MAX_OUTPUT_BYTES + 1,
      }),
    ).toThrow(/byteLimit is too large/u);
  });

  it("normalizes read start/start_line aliases without accepting unrelated unknown args", () => {
    expect(parseReadArgs({ path: "README.md", start: 3, limit: 2 })).toEqual({
      path: "README.md",
      offset: 3,
      limit: 2,
    });
    expect(parseReadArgs({ path: "README.md", start_line: 4 })).toEqual({
      path: "README.md",
      offset: 4,
    });
    expect(() => parseReadArgs({ path: "README.md", offset: 2, start: 3 })).toThrow(/conflicting/u);
    expect(() => parseReadArgs({ path: "README.md", offset: 2, start_line: 3 })).toThrow(
      /conflicting/u,
    );
    expect(() => parseReadArgs({ path: "README.md", startLine: 3 })).toThrow("invalid arguments");
  });

  it("keeps raw read schema guards aligned with normalized read aliases", () => {
    expect(() => ReadArgs.parse({ path: "README.md", byteLimit: 1 })).toThrow(
      /byteOffset and byteLimit/u,
    );
    expect(() =>
      ReadArgs.parse({ path: "README.md", byteOffset: 0, byteLimit: 1, start_line: 1 }),
    ).toThrow(/cannot be combined/u);
    expect(() => ReadArgs.parse({ path: "README.md", offset: 2, start: 3 })).toThrow(
      /conflicting 'start' and 'offset'/u,
    );
    expect(() => ReadArgs.parse({ path: "README.md", start: 2, start_line: 3 })).toThrow(
      /conflicting 'start' and 'start_line'/u,
    );
  });

  it("reads a full file and supports offset/limit slicing", () => {
    const workspace = tempDir("keel-typed-read-");
    writeFileSync(join(workspace, "notes.txt"), "one\ntwo\nthree\n");

    expect(executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace })).toBe(
      "one\ntwo\nthree\n",
    );
    expect(
      executeReadTool({ path: "notes.txt", offset: 2, limit: 1 }, { workspaceRoot: workspace }),
    ).toBe("two");
  });

  it("returns offset guidance when the requested slice starts past the end", () => {
    const workspace = tempDir("keel-typed-read-offset-");
    writeFileSync(join(workspace, "notes.txt"), "one\n");

    expect(executeReadTool({ path: "notes.txt", offset: 5 }, { workspaceRoot: workspace })).toBe(
      "read: offset 5 is past end of file (2 lines)",
    );
    expect(executeReadTool({ path: "notes.txt", offset: 2 }, { workspaceRoot: workspace })).toBe(
      "",
    );
  });

  it("fails closed for invalid, outside-workspace, and symlink-escaped paths", () => {
    const workspace = tempDir("keel-typed-read-paths-");
    const outside = tempDir("keel-typed-read-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(workspace, "link"));

    expect(() => executeReadTool({ path: "bad\0path" }, { workspaceRoot: workspace })).toThrow(
      /NUL byte/u,
    );
    expect(() => executeReadTool({ path: "../escape.txt" }, { workspaceRoot: workspace })).toThrow(
      /outside the workspace/u,
    );
    expect(() => executeReadTool({ path: "link" }, { workspaceRoot: workspace })).toThrow(
      /outside the workspace/u,
    );
  });

  it("rechecks containment after opening read targets for whole, byte, and large-line reads", () => {
    for (const variant of ["whole", "byte", "large-line"] as const) {
      const workspace = tempDir(`keel-typed-read-toctou-${variant}-`);
      const outside = tempDir(`keel-typed-read-toctou-outside-${variant}-`);
      const target = join(workspace, "notes.txt");
      const outsideTarget = join(outside, "secret.txt");
      writeFileSync(target, "alpha\nSECRET\nomega\n");
      writeFileSync(outsideTarget, "outside secret");

      const args =
        variant === "byte"
          ? { path: "notes.txt", byteOffset: 0, byteLimit: 5 }
          : variant === "large-line"
            ? { path: "notes.txt", offset: 2, limit: 1 }
            : { path: "notes.txt" };
      const options =
        variant === "large-line"
          ? {
              workspaceRoot: workspace,
              realpath: realpathThatMovesTargetAfterValidation(target, outsideTarget),
              stat: () => statLike({ size: READ_MAX_FILE_BYTES + 1 }),
            }
          : {
              workspaceRoot: workspace,
              realpath: realpathThatMovesTargetAfterValidation(target, outsideTarget),
            };

      expect(() => executeReadTool(args, options)).toThrow(/outside the workspace|changed/u);
    }
  });

  it("fails closed when realpath cannot verify containment", () => {
    const workspace = tempDir("keel-typed-read-realpath-");
    writeFileSync(join(workspace, "notes.txt"), "text");

    expect(() =>
      executeReadTool(
        { path: "notes.txt" },
        {
          workspaceRoot: workspace,
          realpath: (path) => {
            if (path === workspace) return workspace;
            throw errno("EIO");
          },
        },
      ),
    ).toThrow(/cannot resolve path/u);
  });

  it("normalizes stat failures into read guidance", () => {
    const workspace = tempDir("keel-typed-read-stat-");
    writeFileSync(join(workspace, "notes.txt"), "text");

    expect(() =>
      executeReadTool(
        { path: "missing.txt" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw errno("ENOENT");
          },
        },
      ),
    ).toThrow("read: 'missing.txt' does not exist");
    expect(() =>
      executeReadTool(
        { path: "notes.txt" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw errno("EACCES");
          },
        },
      ),
    ).toThrow("permission denied");
    expect(() =>
      executeReadTool(
        { path: "notes.txt" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw errno("ENOTDIR");
          },
        },
      ),
    ).toThrow("parent path component");
    expect(() =>
      executeReadTool(
        { path: "notes.txt" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw new Error("boom");
          },
        },
      ),
    ).toThrow("cannot read 'notes.txt': boom");
    expect(() =>
      executeReadTool(
        { path: "notes.txt" },
        {
          workspaceRoot: workspace,
          stat: () => throwNonError("string boom"),
        },
      ),
    ).toThrow("cannot read 'notes.txt': string boom");
    expect(() =>
      executeReadTool(
        { path: "notes.txt" },
        {
          workspaceRoot: workspace,
          stat: () => throwNonError({ boom: true }),
        },
      ),
    ).toThrow("cannot read 'notes.txt': unknown error");
  });

  it("rejects directories, files above the hard cap, and binary files", () => {
    const workspace = tempDir("keel-typed-read-guards-");
    mkdirSync(join(workspace, "dir"));
    writeFileSync(join(workspace, "binary.bin"), Buffer.from([0x66, 0x00, 0x67]));
    writeFileSync(join(workspace, "huge.txt"), "placeholder");

    expect(() => executeReadTool({ path: "dir" }, { workspaceRoot: workspace })).toThrow(
      "is a directory",
    );
    expect(() =>
      executeReadTool(
        { path: "huge.txt" },
        {
          workspaceRoot: workspace,
          stat: () => statLike({ size: READ_MAX_FILE_BYTES + 1 }),
        },
      ),
    ).toThrow("too large to read");
    writeFileSync(join(workspace, "race.txt"), Buffer.alloc(READ_MAX_FILE_BYTES + 1, 0x78));
    expect(() =>
      executeReadTool(
        { path: "race.txt" },
        {
          workspaceRoot: workspace,
          stat: () => statLike({ size: 1 }),
        },
      ),
    ).toThrow(/grew beyond|too large/u);
    expect(() => executeReadTool({ path: "binary.bin" }, { workspaceRoot: workspace })).toThrow(
      "binary file",
    );
    writeFileSync(
      join(workspace, "late-binary.bin"),
      Buffer.concat([Buffer.from("a".repeat(READ_BINARY_SNIFF_BYTES)), Buffer.from([0])]),
    );
    expect(() =>
      executeReadTool({ path: "late-binary.bin" }, { workspaceRoot: workspace }),
    ).toThrow("binary file");
    writeFileSync(join(workspace, "bad-utf8.txt"), Buffer.from([0xc3]));
    expect(() => executeReadTool({ path: "bad-utf8.txt" }, { workspaceRoot: workspace })).toThrow(
      /not complete UTF-8/u,
    );
  });

  it("truncates a single overlong line and rejects an overlong multi-line range", () => {
    const workspace = tempDir("keel-typed-read-large-");
    writeFileSync(join(workspace, "single.txt"), "a".repeat(READ_MAX_OUTPUT_BYTES + 10));
    writeFileSync(
      join(workspace, "multi.txt"),
      ["a".repeat(READ_MAX_OUTPUT_BYTES / 2), "b".repeat(READ_MAX_OUTPUT_BYTES / 2)].join("\n"),
    );

    const single = executeReadTool({ path: "single.txt" }, { workspaceRoot: workspace });
    expect(single).toContain("[line truncated");
    expect(Buffer.byteLength(single, "utf8")).toBeGreaterThan(READ_MAX_OUTPUT_BYTES);

    expect(() => executeReadTool({ path: "multi.txt" }, { workspaceRoot: workspace })).toThrow(
      "selected range is too large",
    );
  });

  it("allows bounded line slices of files larger than the whole-file ceiling", () => {
    const workspace = tempDir("keel-typed-read-large-line-slice-");
    writeFileSync(join(workspace, "huge.log"), "header\nTARGET\ntail");

    expect(
      executeReadTool(
        { path: "huge.log", limit: 1 },
        {
          workspaceRoot: workspace,
          stat: () => statLike({ size: READ_MAX_FILE_BYTES + 1 }),
        },
      ),
    ).toBe("header");

    expect(
      executeReadTool(
        { path: "huge.log", offset: 2, limit: 1 },
        {
          workspaceRoot: workspace,
          stat: () => statLike({ size: READ_MAX_FILE_BYTES + 1 }),
        },
      ),
    ).toBe("TARGET");
    expect(() =>
      executeReadTool(
        { path: "huge.log", offset: 2 },
        {
          workspaceRoot: workspace,
          stat: () => statLike({ size: READ_MAX_FILE_BYTES + 1 }),
        },
      ),
    ).toThrow(/too large.*offset\/limit.*byteOffset\/byteLimit/u);
  });

  it("handles large-file line slices at EOF boundaries without reading the whole file", () => {
    const workspace = tempDir("keel-typed-read-large-line-eof-");
    let limited = false;
    writeFileSync(join(workspace, "huge.log"), "header\nTARGET\ntail");
    writeFileSync(join(workspace, "trailing-newline.log"), "header\n");

    const largeFileStat = (): Stats => statLike({ size: READ_MAX_FILE_BYTES + 1 });

    expect(
      executeReadTool(
        { path: "huge.log", offset: 3, limit: 2 },
        {
          workspaceRoot: workspace,
          stat: largeFileStat,
        },
      ),
    ).toBe("tail");
    expect(
      executeReadTool(
        { path: "trailing-newline.log", offset: 2, limit: 1 },
        {
          workspaceRoot: workspace,
          stat: largeFileStat,
        },
      ),
    ).toBe("");
    expect(
      executeReadTool(
        { path: "huge.log", offset: 20, limit: 1 },
        {
          workspaceRoot: workspace,
          stat: largeFileStat,
          onLimited: () => {
            limited = true;
          },
        },
      ),
    ).toBe("read: offset 20 is past end of file (3 lines)");
    expect(limited).toBe(true);
  });

  it("keeps large-file line slices bounded and rejects oversized multi-line selections", () => {
    const workspace = tempDir("keel-typed-read-large-line-bounds-");
    const largeFileStat = (): Stats => statLike({ size: READ_MAX_FILE_BYTES + 1 });
    let limited = false;
    writeFileSync(join(workspace, "single.txt"), "a".repeat(READ_MAX_OUTPUT_BYTES + 10));
    writeFileSync(
      join(workspace, "multi.txt"),
      ["a".repeat(READ_MAX_OUTPUT_BYTES / 2), "b".repeat(READ_MAX_OUTPUT_BYTES / 2)].join("\n"),
    );

    const single = executeReadTool(
      { path: "single.txt", offset: 1, limit: 1 },
      {
        workspaceRoot: workspace,
        stat: largeFileStat,
        onLimited: () => {
          limited = true;
        },
      },
    );
    expect(single).toContain("[line truncated");
    expect(limited).toBe(true);
    expect(() =>
      executeReadTool(
        { path: "multi.txt", offset: 1, limit: 2 },
        {
          workspaceRoot: workspace,
          stat: largeFileStat,
        },
      ),
    ).toThrow("selected range is too large");
  });

  it("refuses deep large-file line slices after a bounded scan budget", () => {
    const workspace = tempDir("keel-typed-read-large-line-deep-");
    writeFileSync(join(workspace, "deep.log"), "x".repeat(READ_MAX_LARGE_LINE_SCAN_BYTES + 1024));

    expect(() =>
      executeReadTool(
        { path: "deep.log", offset: 2, limit: 1 },
        {
          workspaceRoot: workspace,
          stat: () => statLike({ size: READ_MAX_FILE_BYTES + 1 }),
        },
      ),
    ).toThrow(/line slice scan exceeded|byteOffset\/byteLimit/u);
  });

  it("refuses binary and invalid UTF-8 large-file line slices", () => {
    const workspace = tempDir("keel-typed-read-large-line-text-guards-");
    const largeFileStat = (): Stats => statLike({ size: READ_MAX_FILE_BYTES + 1 });

    writeFileSync(join(workspace, "huge-binary.log"), Buffer.from([0x41, 0x00, 0x42]));
    expect(() =>
      executeReadTool(
        { path: "huge-binary.log", offset: 1, limit: 1 },
        { workspaceRoot: workspace, stat: largeFileStat },
      ),
    ).toThrow(/binary/u);

    writeFileSync(join(workspace, "huge-invalid-utf8.log"), Buffer.from([0xff]));
    expect(() =>
      executeReadTool(
        { path: "huge-invalid-utf8.log", offset: 1, limit: 1 },
        { workspaceRoot: workspace, stat: largeFileStat },
      ),
    ).toThrow(/not complete UTF-8/u);

    writeFileSync(join(workspace, "huge-incomplete-utf8.log"), Buffer.from([0xc3]));
    expect(() =>
      executeReadTool(
        { path: "huge-incomplete-utf8.log", offset: 1, limit: 1 },
        { workspaceRoot: workspace, stat: largeFileStat },
      ),
    ).toThrow(/not complete UTF-8/u);
  });

  it("allows bounded byte slices of files larger than the whole-file ceiling", () => {
    const workspace = tempDir("keel-typed-read-byte-slice-");
    writeFileSync(join(workspace, "huge.log"), "prefix\nneedle\nsuffix");

    expect(
      executeReadTool(
        { path: "huge.log", byteOffset: "prefix\n".length, byteLimit: "needle\n".length },
        {
          workspaceRoot: workspace,
          stat: () => statLike({ size: READ_MAX_FILE_BYTES + 1 }),
        },
      ),
    ).toBe("needle\n");
  });

  it("fails closed for binary and incomplete UTF-8 byte slices", () => {
    const workspace = tempDir("keel-typed-read-byte-guards-");
    writeFileSync(join(workspace, "binary.bin"), Buffer.from([0x66, 0x00, 0x67]));
    writeFileSync(join(workspace, "partial-utf8.txt"), Buffer.from([0xc3]));

    expect(() =>
      executeReadTool(
        { path: "binary.bin", byteOffset: 0, byteLimit: 3 },
        { workspaceRoot: workspace },
      ),
    ).toThrow("binary file");
    expect(() =>
      executeReadTool(
        { path: "partial-utf8.txt", byteOffset: 0, byteLimit: 1 },
        { workspaceRoot: workspace },
      ),
    ).toThrow(/not complete UTF-8/u);
  });

  it("does not allow a tracked byte slice to authorize editing a binary file", () => {
    const workspace = tempDir("keel-typed-read-byte-whole-file-binary-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "mixed.bin"), Buffer.from([0x00, 0x61, 0x62, 0x63]));

    expect(
      executeReadTool(
        { path: "mixed.bin", byteOffset: 1, byteLimit: 3 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("abc");
    expect(() =>
      executeEditTool(
        { path: "mixed.bin", oldString: "abc", newString: "def" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow("binary file");
  });

  it("does not allow a tracked byte slice to authorize editing invalid UTF-8", () => {
    const workspace = tempDir("keel-typed-read-byte-invalid-utf8-edit-");
    const state = createTypedToolState();
    const mixed = Buffer.from([0x61, 0x62, 0x63, 0xff]);
    writeFileSync(join(workspace, "mixed.txt"), mixed);

    expect(
      executeReadTool(
        { path: "mixed.txt", byteOffset: 0, byteLimit: 3 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("abc");
    expect(() =>
      executeEditTool(
        { path: "mixed.txt", oldString: "abc", newString: "def" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow(/not complete UTF-8/u);
    expect(readFileSync(join(workspace, "mixed.txt"))).toEqual(mixed);
  });

  it("preserves a leading UTF-8 BOM across full read and edit", () => {
    const workspace = tempDir("keel-typed-edit-bom-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63]));

    expect(executeReadTool({ path: "bom.txt" }, { workspaceRoot: workspace, state })).toBe(
      "\uFEFFabc",
    );
    expect(
      executeEditTool(
        { path: "bom.txt", oldString: "\uFEFFabc", newString: "\uFEFFdef" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'bom.txt'");
    expect(readFileSync(join(workspace, "bom.txt"))).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf, 0x64, 0x65, 0x66]),
    );
  });

  it("validates byte-slice arguments before reading", () => {
    const workspace = tempDir("keel-typed-read-byte-params-");
    writeFileSync(join(workspace, "notes.txt"), "abcdef");

    expect(() =>
      executeReadTool({ path: "notes.txt", byteOffset: 1 }, { workspaceRoot: workspace }),
    ).toThrow(/byteOffset and byteLimit/u);
    expect(() =>
      executeReadTool(
        { path: "notes.txt", byteOffset: 1, byteLimit: 2, offset: 1 },
        { workspaceRoot: workspace },
      ),
    ).toThrow(/cannot be combined/u);
    expect(() =>
      executeReadTool(
        { path: "notes.txt", byteOffset: 0, byteLimit: READ_MAX_OUTPUT_BYTES + 1 },
        { workspaceRoot: workspace },
      ),
    ).toThrow(/byteLimit is too large/u);
    expect(
      executeReadTool(
        { path: "notes.txt", byteOffset: 999, byteLimit: 1 },
        { workspaceRoot: workspace },
      ),
    ).toContain("past end of file");
  });
});

describe("warden typed search tool", () => {
  it("parses search args and returns clean invalid-arg guidance", () => {
    expect(parseSearchArgs({ pattern: "needle", kind: "filename", maxResults: 3 })).toEqual({
      pattern: "needle",
      kind: "filename",
      maxResults: 3,
    });
    expect(() => parseSearchArgs({ pattern: "needle", kind: "filename", glob: "src/**" })).toThrow(
      /glob is only supported for content searches/u,
    );

    expect(() => parseSearchArgs({ kind: "content" })).toThrow(TypedToolError);
    try {
      parseSearchArgs({ kind: "content" });
    } catch (error) {
      if (!(error instanceof TypedToolError)) throw error;
      expect(error.code).toBe("INVALID_PARAMS");
      expect(error.message).toContain("invalid 'pattern'");
    }
  });

  it("normalizes search path/output_mode aliases with workspace containment", () => {
    const workspace = tempDir("keel-typed-search-alias-");
    const canonicalWorkspace = realpathSync(workspace);
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a.txt"), "needle");
    const outside = tempDir("keel-typed-search-outside-alias-");

    expect(
      parseSearchArgs(
        { pattern: "needle", path: join(canonicalWorkspace, "src"), output_mode: "content" },
        { workspaceRoot: workspace },
      ),
    ).toEqual({ pattern: "needle", kind: "content", glob: "src/**" });
    expect(
      parseSearchArgs({ pattern: "needle", path: "src/a.txt" }, { workspaceRoot: workspace }),
    ).toEqual({ pattern: "needle", glob: "src/a.txt" });
    expect(parseSearchArgs({ pattern: "needle", path: "src" })).toEqual({
      pattern: "needle",
      glob: "src",
    });
    expect(parseSearchArgs({ pattern: "needle", path: "." }, { workspaceRoot: workspace })).toEqual(
      {
        pattern: "needle",
        glob: "**",
      },
    );
    expect(
      parseSearchArgs({ pattern: "needle", path: "src/*.txt" }, { workspaceRoot: workspace }),
    ).toEqual({ pattern: "needle", glob: "src/\\*.txt" });
    expect(() =>
      parseSearchArgs(
        { pattern: "needle", path: "src", glob: "src/**" },
        { workspaceRoot: workspace },
      ),
    ).toThrow(/conflicting/u);
    expect(
      parseSearchArgs(
        { pattern: "needle", path: "src/name[old].txt" },
        { workspaceRoot: workspace },
      ),
    ).toEqual({ pattern: "needle", glob: "src/name\\[old\\].txt" });
    expect(
      parseSearchArgs(
        { pattern: "needle", path: "src/brace{one}.txt" },
        { workspaceRoot: workspace },
      ),
    ).toEqual({ pattern: "needle", glob: "src/brace\\{one\\}.txt" });
    expect(
      parseSearchArgs({ pattern: "needle", path: "missing.txt" }, { workspaceRoot: workspace }),
    ).toEqual({ pattern: "needle", glob: "missing.txt" });
    expect(() =>
      parseSearchArgs(
        { pattern: "needle", path: "src", glob: "*.txt" },
        { workspaceRoot: workspace },
      ),
    ).toThrow(/conflicting/u);
    expect(() =>
      parseSearchArgs(
        { pattern: "needle", path: "src", output_mode: "content", kind: "filename" },
        { workspaceRoot: workspace },
      ),
    ).toThrow(/conflicting/u);
    expect(() =>
      parseSearchArgs(
        { pattern: "needle", path: "src", kind: "filename" },
        { workspaceRoot: workspace },
      ),
    ).toThrow(/path is only supported/u);
    expect(() =>
      parseSearchArgs({ pattern: "needle", path: "" }, { workspaceRoot: workspace }),
    ).toThrow(/path must be a non-empty string/u);
    expect(() =>
      parseSearchArgs({ pattern: "needle", path: 1 }, { workspaceRoot: workspace }),
    ).toThrow(/path must be a non-empty string/u);
    expect(() =>
      parseSearchArgs(
        { pattern: "needle", path: join(outside, "secret.txt") },
        { workspaceRoot: workspace },
      ),
    ).toThrow(/outside the workspace/u);
    expect(() =>
      parseSearchArgs(
        { pattern: "needle", path: "src", output_mode: "json" },
        { workspaceRoot: workspace },
      ),
    ).toThrow(TypedToolError);
  });

  it("keeps raw search schema guards aligned with normalized compatibility aliases", () => {
    expect(() =>
      SearchArgs.parse({ pattern: "needle", output_mode: "content", kind: "filename" }),
    ).toThrow(/conflicting output_mode/u);
    expect(() => SearchArgs.parse({ pattern: "needle", path: "src", kind: "filename" })).toThrow(
      /path is only supported/u,
    );
    expect(() => SearchArgs.parse({ pattern: "needle", path: "src", glob: "src/**" })).toThrow(
      /conflicting 'path' and 'glob'/u,
    );
    expect(() => SearchArgs.parse({ pattern: "needle", kind: "filename", glob: "src/**" })).toThrow(
      /glob is only supported/u,
    );
  });

  it("runs content search with minimal child env, caps results, and filters escaped paths", async () => {
    const workspace = tempDir("keel-typed-search-content-");
    const outside = tempDir("keel-typed-search-outside-");
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a.txt"), "needle one");
    writeFileSync(join(outside, "secret.txt"), "needle secret");
    symlinkSync(outside, join(workspace, "link"));
    const seen: { cmd?: string; args?: string[]; opts?: SpawnOptions } = {};
    const longLine = "x".repeat(1500);
    const spawn = fakeSpawn((child) => {
      child.stdout.write("not json\n");
      child.stdout.write(
        `${JSON.stringify({
          type: "match",
          data: {
            path: { text: "src/a.txt" },
            line_number: 1,
            lines: { text: `${longLine}\n` },
            submatches: [{ start: 2 }],
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "match",
          data: {
            path: { text: "link/secret.txt" },
            line_number: 1,
            lines: { text: "needle secret\n" },
            submatches: [{ start: 0 }],
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "match",
          data: {
            path: { text: "src/b.txt" },
            line_number: 2,
            lines: { text: "needle two\n" },
            submatches: [{ start: 0 }],
          },
        })}\n`,
      );
      child.emit("close", 0);
    }, seen);

    const output = await executeSearchTool(
      { pattern: "needle", maxResults: 1 },
      {
        workspaceRoot: workspace,
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "must-not-inherit", KEEL_RG_PATH: "fake-rg" },
        spawn,
      },
    );

    expect(seen.cmd).toBe("fake-rg");
    expect(seen.args).toEqual([
      "--json",
      "--color=never",
      "--sort",
      "path",
      "--max-columns",
      String(SEARCH_MAX_LINE_BYTES),
      "--max-columns-preview",
      "--",
      "needle",
      ".",
    ]);
    expect(seen.opts?.env).toEqual({ PATH: "/usr/bin", LC_ALL: "C", LANG: "C" });
    expect(output).toContain("src/a.txt:1:3:");
    expect(output).toContain("[line truncated]");
    expect(output).toContain("... 1+ more matches");
    expect(output).not.toContain("secret");
  });

  it("escapes control characters in content result paths before model-visible output", async () => {
    const workspace = tempDir("keel-typed-search-control-content-");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "evil\nfake.txt"), "needle");

    const output = await executeSearchTool(
      { pattern: "needle" },
      {
        workspaceRoot: workspace,
        rgPath: "fake-rg",
        spawn: fakeSpawn((child) => {
          child.stdout.write(
            `${JSON.stringify({
              type: "match",
              data: {
                path: { text: "src/evil\nfake.txt" },
                line_number: 1,
                lines: { text: "needle\n" },
                submatches: [{ start: 0 }],
              },
            })}\n`,
          );
          child.emit("close", 0);
        }),
      },
    );

    expect(output).toBe('"src/evil\\nfake.txt":1:1:needle');
    expect(output).not.toContain("src/evil\nfake.txt");
  });

  it("scopes concrete content globs at rg execution while still filtering returned paths", async () => {
    const workspace = tempDir("keel-typed-search-scoped-content-");
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a.txt"), "needle scoped");
    writeFileSync(join(workspace, "outside.txt"), "needle broad");
    writeFileSync(join(workspace, ".env"), "needle hidden");
    const calls: string[][] = [];
    const output = await executeSearchTool(
      { pattern: "needle", glob: "src/**" },
      {
        workspaceRoot: workspace,
        rgPath: "fake-rg",
        spawn: (_cmd, args, _opts) => {
          calls.push(args);
          const child = fakeChild();
          setImmediate(() => {
            for (const [path, text] of [
              ["src/a.txt", "needle scoped"],
              ["outside.txt", "needle broad"],
              [".env", "needle hidden"],
            ] as const) {
              child.stdout.write(
                `${JSON.stringify({
                  type: "match",
                  data: {
                    path: { text: path },
                    line_number: 1,
                    lines: { text: `${text}\n` },
                    submatches: [{ start: 0 }],
                  },
                })}\n`,
              );
            }
            child.emit("close", 0);
          });
          return child;
        },
      },
    );

    expect(output).toBe("src/a.txt:1:1:needle scoped");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--json");
    expect(calls[0]).not.toContain("--files");
    expect(calls[0]).toContain("src");
    expect(calls[0]).not.toContain("src/a.txt");
  });

  it("returns no scoped content matches without spawning rg when the scope is missing", async () => {
    const workspace = tempDir("keel-typed-search-no-scoped-candidates-");
    const calls: string[][] = [];
    const output = await executeSearchTool(
      { pattern: "needle", glob: "src/**" },
      {
        workspaceRoot: workspace,
        rgPath: "fake-rg",
        spawn: (_cmd, args) => {
          calls.push(args);
          const child = fakeChild();
          setImmediate(() => {
            child.stdout.write(
              `${JSON.stringify({
                type: "match",
                data: {
                  path: { text: "README.md" },
                  line_number: 1,
                  lines: { text: "needle root\n" },
                  submatches: [{ start: 0 }],
                },
              })}\n`,
            );
            child.emit("close", 0);
          });
          return child;
        },
      },
    );

    expect(output).toBe("search: no matches.");
    expect(calls).toHaveLength(0);
  });

  it("stops scoped content output after the result cap without chunking candidate paths", async () => {
    const workspace = tempDir("keel-typed-search-scoped-chunks-");
    const candidates = ["src/a.txt", "src/b.txt", "src/c.txt"];
    mkdirSync(join(workspace, "src"), { recursive: true });
    for (const candidate of candidates) writeFileSync(join(workspace, candidate), "needle");
    const calls: string[][] = [];
    const output = await executeSearchTool(
      { pattern: "needle", glob: "src/**", maxResults: 1 },
      {
        workspaceRoot: workspace,
        rgPath: "fake-rg",
        spawn: (_cmd, args) => {
          calls.push(args);
          const child = fakeChild();
          setImmediate(() => {
            for (const candidate of candidates) {
              child.stdout.write(
                `${JSON.stringify({
                  type: "match",
                  data: {
                    path: { text: candidate },
                    line_number: 1,
                    lines: { text: "needle\n" },
                    submatches: [{ start: 0 }],
                  },
                })}\n`,
              );
            }
            child.emit("close", 0);
          });
          return child;
        },
      },
    );

    const contentCalls = calls.filter((args) => args.includes("--json"));
    expect(contentCalls).toHaveLength(1);
    expect(contentCalls[0]).toContain("src");
    expect(contentCalls[0]).not.toContain(candidates[0]);
    expect(contentCalls[0]).not.toContain(candidates.at(-1)!);
    expect(output).toBe(
      `${candidates[0]}:1:1:needle\n... 1+ more matches; refine the pattern or glob.`,
    );
  });

  it("executes a search path alias by filtering the normalized glob after visible traversal", async () => {
    const workspace = tempDir("keel-typed-search-path-exec-");
    const canonicalWorkspace = realpathSync(workspace);
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a.txt"), "needle");
    const seen: { cmd?: string; args?: string[]; opts?: SpawnOptions } = {};
    const output = await executeSearchTool(
      { pattern: "needle", path: join(canonicalWorkspace, "src"), output_mode: "content" },
      {
        workspaceRoot: workspace,
        rgPath: "fake-rg",
        spawn: (cmd, args, opts) => {
          seen.cmd = cmd;
          seen.args = args;
          seen.opts = opts;
          const child = fakeChild();
          setImmediate(() => {
            if (args.includes("--files")) {
              child.stdout.write("src/a.txt\n");
            } else {
              child.stdout.write(
                `${JSON.stringify({
                  type: "match",
                  data: {
                    path: { text: "src/a.txt" },
                    line_number: 1,
                    lines: { text: "needle\n" },
                    submatches: [{ start: 0 }],
                  },
                })}\n`,
              );
            }
            child.emit("close", 0);
          });
          return child;
        },
      },
    );
    expect(seen.args).not.toContain("--glob=src/**");
    expect(seen.args).toContain("--json");
    expect(seen.args).toContain("src");
    expect(seen.args).not.toContain("src/a.txt");
    expect(output).toBe("src/a.txt:1:1:needle");
  });

  it("rejects NUL-bearing content search patterns before spawning ripgrep", async () => {
    const workspace = tempDir("keel-typed-search-nul-pattern-");
    expect(() => parseSearchArgs({ pattern: "need\0le" }, { workspaceRoot: workspace })).toThrow(
      /NUL byte/u,
    );
    await expect(
      executeSearchTool(
        { pattern: "need\0le" },
        {
          workspaceRoot: workspace,
          rgPath: "fake-rg",
          spawn: () => {
            throw new Error("spawn must not run for invalid search pattern");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("does not widen a slashless search path alias to nested basename matches", async () => {
    const workspace = tempDir("keel-typed-search-path-slashless-");
    writeFileSync(join(workspace, "README.md"), "needle root");
    mkdirSync(join(workspace, "docs"));
    writeFileSync(join(workspace, "docs", "README.md"), "needle nested");

    const output = await executeSearchTool(
      { pattern: "needle", path: "README.md" },
      {
        workspaceRoot: workspace,
        rgPath: "fake-rg",
        spawn: (_cmd, args, _opts) => {
          const child = fakeChild();
          setImmediate(() => {
            if (args.includes("--files")) {
              child.stdout.write("README.md\n");
              child.stdout.write("docs/README.md\n");
            } else {
              for (const emitted of ["README.md", "docs/README.md"]) {
                child.stdout.write(
                  `${JSON.stringify({
                    type: "match",
                    data: {
                      path: { text: emitted },
                      line_number: 1,
                      lines: {
                        text: emitted === "README.md" ? "needle root\n" : "needle nested\n",
                      },
                      submatches: [{ start: 0 }],
                    },
                  })}\n`,
                );
              }
            }
            child.emit("close", 0);
          });
          return child;
        },
      },
    );

    expect(output).toBe("README.md:1:1:needle root");
  });

  it("applies filename/content globs after ripgrep's visible-file traversal", async () => {
    const workspace = tempDir("keel-typed-search-visible-");
    mkdirSync(join(workspace, "packages", "eval", "src"), { recursive: true });
    writeFileSync(join(workspace, "packages", "eval", "src", "index.ts"), "needle");
    const filenameSeen: { cmd?: string; args?: string[]; opts?: SpawnOptions } = {};
    const filenameOutput = await executeSearchTool(
      { pattern: "packages/**", kind: "filename" },
      {
        workspaceRoot: workspace,
        rgPath: "fake-rg",
        spawn: fakeSpawn((child) => {
          child.stdout.write("packages/.DS_Store\0");
          child.stdout.write(".env\0");
          child.stdout.write("packages/eval/src/index.ts\0");
          child.stdout.write("README.md\0");
          child.emit("close", 0);
        }, filenameSeen),
      },
    );
    expect(filenameSeen.args).toEqual(["--files", "--null", "--sort", "path"]);
    expect(filenameOutput).toBe("packages/eval/src/index.ts");

    const contentSeen: { cmd?: string; args?: string[]; opts?: SpawnOptions } = {};
    const contentOutput = await executeSearchTool(
      { pattern: "needle", glob: "packages/**" },
      {
        workspaceRoot: workspace,
        rgPath: "fake-rg",
        spawn: (cmd, args, opts) => {
          contentSeen.cmd = cmd;
          contentSeen.args = args;
          contentSeen.opts = opts;
          const child = fakeChild();
          setImmediate(() => {
            if (args.includes("--files")) {
              child.stdout.write("packages/.DS_Store\n");
              child.stdout.write(".env\n");
              child.stdout.write("packages/eval/src/index.ts\n");
              child.stdout.write("README.md\n");
            } else {
              for (const path of [
                "packages/.DS_Store",
                ".env",
                "packages/eval/src/index.ts",
                "README.md",
              ]) {
                child.stdout.write(
                  `${JSON.stringify({
                    type: "match",
                    data: {
                      path: { text: path },
                      line_number: 1,
                      lines: { text: "needle\n" },
                      submatches: [{ start: 0 }],
                    },
                  })}\n`,
                );
              }
            }
            child.emit("close", 0);
          });
          return child;
        },
      },
    );
    expect(contentSeen.args).toEqual([
      "--json",
      "--color=never",
      "--sort",
      "path",
      "--max-columns",
      String(SEARCH_MAX_LINE_BYTES),
      "--max-columns-preview",
      "--",
      "needle",
      "packages",
    ]);
    expect(contentOutput).toBe("packages/eval/src/index.ts:1:1:needle");
  });

  it("escapes control characters in filename result paths before model-visible output", async () => {
    const workspace = tempDir("keel-typed-search-control-filename-");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "\u001b[31mred.txt"), "needle");
    const seen: { args?: string[] } = {};

    const output = await executeSearchTool(
      { pattern: "src/**", kind: "filename" },
      {
        workspaceRoot: workspace,
        rgPath: "fake-rg",
        spawn: fakeSpawn((child) => {
          child.stdout.write("src/\u001b[31mred.txt\0");
          child.emit("close", 0);
        }, seen),
      },
    );

    expect(output).toBe('"src/\\u001b[31mred.txt"');
    expect(output).not.toContain("\u001b");
    expect(seen.args).toContain("--null");
  });

  it("keeps newline and control-character filenames as single escaped filename results", async () => {
    const workspace = tempDir("keel-typed-search-filename-null-");
    const names = [
      "visible\nFAKE.txt",
      "tab\tname.txt",
      "carriage\rname.txt",
      "term\u001b[31mred.txt",
    ];

    const output = await executeSearchTool(
      { pattern: "**", kind: "filename" },
      {
        workspaceRoot: workspace,
        spawn: fakeSpawn((child) => {
          child.stdout.write(`${names.join("\0")}\0`);
          child.emit("close", 0);
        }),
      },
    );

    expect(output.split("\n")).toEqual([
      '"visible\\nFAKE.txt"',
      '"tab\\tname.txt"',
      '"carriage\\rname.txt"',
      '"term\\u001b[31mred.txt"',
    ]);
    expect(output).not.toContain("visible\nFAKE.txt");
    expect(output).not.toContain("\u001b");
  });

  it("executes literal search path aliases without widening glob metacharacters", async () => {
    const workspace = tempDir("keel-typed-search-literal-path-");
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "a*b.txt"), "needle");
    writeFileSync(join(workspace, "src", "ab.txt"), "needle");
    writeFileSync(join(workspace, "src", "name[old].txt"), "needle");
    writeFileSync(join(workspace, "src", "nameo.txt"), "needle");
    writeFileSync(join(workspace, "src", "brace{one}.txt"), "needle");
    writeFileSync(join(workspace, "src", "braceone.txt"), "needle");
    writeFileSync(join(workspace, "src", "a+(b).txt"), "needle");
    writeFileSync(join(workspace, "src", "a@(b).txt"), "needle");
    writeFileSync(join(workspace, "src", "a(b|c).txt"), "needle");

    const seen: string[][] = [];
    const run = async (path: string, emittedPaths: readonly string[]): Promise<string> => {
      const call: { cmd?: string; args?: string[]; opts?: SpawnOptions } = {};
      const output = await executeSearchTool(
        { pattern: "needle", path },
        {
          workspaceRoot: workspace,
          rgPath: "fake-rg",
          spawn: (cmd, args, opts) => {
            call.cmd = cmd;
            call.args = args;
            call.opts = opts;
            const child = fakeChild();
            setImmediate(() => {
              if (args.includes("--files")) {
                for (const emitted of emittedPaths) child.stdout.write(`${emitted}\n`);
              } else {
                for (const emitted of emittedPaths) {
                  child.stdout.write(
                    `${JSON.stringify({
                      type: "match",
                      data: {
                        path: { text: emitted },
                        line_number: 1,
                        lines: { text: "needle\n" },
                        submatches: [{ start: 0 }],
                      },
                    })}\n`,
                  );
                }
              }
              child.emit("close", 0);
            });
            return child;
          },
        },
      );
      seen.push(call.args ?? []);
      return output;
    };

    await expect(run("src/a*b.txt", ["src/a*b.txt", "src/ab.txt"])).resolves.toBe(
      "src/a*b.txt:1:1:needle",
    );
    await expect(run("src/name[old].txt", ["src/name[old].txt", "src/nameo.txt"])).resolves.toBe(
      "src/name[old].txt:1:1:needle",
    );
    await expect(
      run("src/brace{one}.txt", ["src/brace{one}.txt", "src/braceone.txt"]),
    ).resolves.toBe("src/brace{one}.txt:1:1:needle");
    await expect(run("src/a+(b).txt", ["src/a+(b).txt", "src/ab.txt"])).resolves.toBe(
      "src/a+(b).txt:1:1:needle",
    );
    await expect(run("src/a@(b).txt", ["src/a@(b).txt", "src/ab.txt"])).resolves.toBe(
      "src/a@(b).txt:1:1:needle",
    );
    await expect(run("src/a(b|c).txt", ["src/a(b|c).txt", "src/ab.txt"])).resolves.toBe(
      "src/a(b|c).txt:1:1:needle",
    );

    expect(seen.map((args) => args.find((arg) => arg.startsWith("--glob=")))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("truncates very large search output while preserving head and tail context", async () => {
    const workspace = tempDir("keel-typed-search-truncate-");
    mkdirSync(join(workspace, "src"));
    const longLine = `needle ${"x".repeat(1500)}`;
    const spawn = fakeSpawn((child) => {
      for (let i = 0; i < 90; i += 1) {
        child.stdout.write(
          `${JSON.stringify({
            type: "match",
            data: {
              path: { text: `src/${String(i).padStart(2, "0")}.txt` },
              line_number: 1,
              lines: { text: `${longLine}\n` },
              submatches: [{ start: 0 }],
            },
          })}\n`,
        );
      }
      child.emit("close", 0);
    });

    const output = await executeSearchTool(
      { pattern: "needle", maxResults: 200 },
      { workspaceRoot: workspace, spawn },
    );

    expect(output).toContain("src/00.txt:1:1:needle");
    expect(output).toContain("... [output truncated] ...");
    expect(output).toContain("src/89.txt:1:1:needle");
  });

  it("runs filename search, returns no-match guidance, and treats rg no-files exit as no matches", async () => {
    const workspace = tempDir("keel-typed-search-filename-");
    writeFileSync(join(workspace, "a.txt"), "a");

    const filename = await executeSearchTool(
      { pattern: "*.txt", kind: "filename" },
      {
        workspaceRoot: workspace,
        rgPath: "rg-from-option",
        spawn: fakeSpawn((child) => {
          child.stdout.write("a.txt\0");
          child.emit("close", 0);
        }),
      },
    );
    expect(filename).toBe("a.txt");

    const noMatches = await executeSearchTool(
      { pattern: "missing", kind: "filename" },
      {
        workspaceRoot: workspace,
        spawn: fakeSpawn((child) => {
          child.emit("close", 1);
        }),
      },
    );
    expect(noMatches).toBe("search: no matches.");

    const noFiles = await executeSearchTool(
      { pattern: "needle" },
      {
        workspaceRoot: workspace,
        spawn: fakeSpawn((child) => {
          child.stdout.write(
            `${JSON.stringify({ type: "summary", data: { stats: { searches: 0 } } })}\n`,
          );
          child.emit("close", 2);
        }),
      },
    );
    expect(noFiles).toBe("search: no matches.");
  });

  it("normalizes ripgrep spawn, timeout, and exit errors", async () => {
    const workspace = tempDir("keel-typed-search-errors-");

    await expect(
      executeSearchTool(
        { pattern: "needle" },
        {
          workspaceRoot: workspace,
          spawn: fakeSpawn((child) => {
            child.emit("error", new Error("spawn boom"));
            child.emit("error", new Error("duplicate terminal event"));
          }),
        },
      ),
    ).rejects.toThrow("cannot run ripgrep: spawn boom");

    const completedSignal = new AbortController();
    const completedChild = fakeChild();
    const completed = executeSearchTool(
      { pattern: "needle" },
      {
        workspaceRoot: workspace,
        signal: completedSignal.signal,
        spawn: () => {
          setImmediate(() => completedChild.emit("close", 0));
          return completedChild;
        },
      },
    );
    await expect(completed).resolves.toBe("search: no matches.");
    completedSignal.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completedChild.kill).not.toHaveBeenCalled();

    await expect(
      executeSearchTool(
        { pattern: "needle" },
        {
          workspaceRoot: workspace,
          timeoutMs: 1,
          spawn: fakeSpawn(() => {
            // Leave the child open so the timeout branch owns the failure.
          }),
        },
      ),
    ).rejects.toThrow("timed out");

    const abort = new AbortController();
    const abortedChild = fakeChild();
    const aborted = executeSearchTool(
      { pattern: "needle" },
      {
        workspaceRoot: workspace,
        timeoutMs: 50,
        signal: abort.signal,
        spawn: () => abortedChild,
      },
    );
    abort.abort();
    await expect(aborted).rejects.toThrow("cancelled");
    expect(abortedChild.kill).toHaveBeenCalledWith("SIGTERM");

    vi.useFakeTimers();
    try {
      const resistantAbort = new AbortController();
      const resistantChild = fakeChild();
      resistantChild.kill = vi.fn(() => true);
      let resistantError: unknown;
      const resistant = executeSearchTool(
        { pattern: "needle" },
        {
          workspaceRoot: workspace,
          timeoutMs: 5_000,
          signal: resistantAbort.signal,
          spawn: () => resistantChild,
        },
      ).catch((error: unknown) => {
        resistantError = error;
      });

      resistantAbort.abort();
      await vi.advanceTimersByTimeAsync(249);
      expect(resistantError).toBeUndefined();
      expect(resistantChild.kill).toHaveBeenCalledTimes(1);
      expect(resistantChild.kill).toHaveBeenLastCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(1);
      expect(resistantError).toBeUndefined();
      expect(resistantChild.kill).toHaveBeenLastCalledWith("SIGKILL");

      resistantChild.emit("close", null, "SIGKILL");
      await resistant;
      expect(resistantError).toBeInstanceOf(TypedToolError);
      expect((resistantError as Error).message).toContain("cancelled");

      const wedgedAbort = new AbortController();
      const wedgedChild = fakeChild();
      wedgedChild.kill = vi.fn(() => true);
      let wedgedError: unknown;
      const wedged = executeSearchTool(
        { pattern: "needle" },
        {
          workspaceRoot: workspace,
          timeoutMs: 5_000,
          signal: wedgedAbort.signal,
          spawn: () => wedgedChild,
        },
      ).catch((error: unknown) => {
        wedgedError = error;
      });

      wedgedAbort.abort();
      await vi.advanceTimersByTimeAsync(2_000);
      await wedged;
      expect(wedgedChild.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(wedgedChild.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(wedgedError).toBeInstanceOf(TypedToolError);
      expect((wedgedError as Error).message).toContain("cancelled");
    } finally {
      vi.useRealTimers();
    }

    await expect(
      executeSearchTool(
        { pattern: "needle" },
        {
          workspaceRoot: workspace,
          spawn: fakeSpawn((child) => {
            child.stderr.write("bad regex");
            child.emit("close", 2);
          }),
        },
      ),
    ).rejects.toThrow("ripgrep error: bad regex");

    await expect(
      executeSearchTool(
        { pattern: "needle" },
        {
          workspaceRoot: workspace,
          spawn: fakeSpawn((child) => {
            child.emit("close", null, "SIGKILL");
          }),
        },
      ),
    ).rejects.toThrow(/terminated by SIGKILL/i);

    await expect(
      executeSearchTool(
        { pattern: "needle" },
        {
          workspaceRoot: workspace,
          spawn: fakeSpawn((child) => {
            child.emit("close", null, null);
          }),
        },
      ),
    ).rejects.toThrow(/without an exit code/i);

    await expect(
      executeSearchTool(
        { pattern: "needle" },
        {
          workspaceRoot: workspace,
          spawn: fakeSpawn((child) => {
            child.emit("close", 7, null);
          }),
        },
      ),
    ).rejects.toThrow(/unexpected exit 7/i);
  });

  it("fails closed and kills ripgrep when raw stdout or stderr exceed control-plane caps", async () => {
    const workspace = tempDir("keel-typed-search-raw-cap-");
    const stdoutChild = fakeChild();
    await expect(
      executeSearchTool(
        { pattern: "needle" },
        {
          workspaceRoot: workspace,
          spawn: () => {
            setImmediate(() =>
              stdoutChild.stdout.write("x".repeat(SEARCH_MAX_RAW_STDOUT_LINE_BYTES + 1)),
            );
            return stdoutChild;
          },
        },
      ),
    ).rejects.toThrow(/output line exceeded/u);
    expect(stdoutChild.kill).toHaveBeenCalled();

    const stderrChild = fakeChild();
    await expect(
      executeSearchTool(
        { pattern: "needle" },
        {
          workspaceRoot: workspace,
          spawn: () => {
            setImmediate(() => stderrChild.stderr.write("e".repeat(SEARCH_MAX_STDERR_BYTES + 1)));
            return stderrChild;
          },
        },
      ),
    ).rejects.toThrow(/stderr exceeded/u);
    expect(stderrChild.kill).toHaveBeenCalled();
  });
});

describe("warden typed write/edit tools", () => {
  it("asks exact-byte admission before retaining optional mutation-presentation content", () => {
    const workspace = tempDir("keel-typed-edit-presentation-admission-");
    const before = "alpha 🧭 old\n";
    const after = "alpha 🧭 replacement\n";
    writeFileSync(join(workspace, "sample.txt"), before);
    const observed: Array<{ observedBeforeBytes: number; verifiedInstalledAfterBytes: number }> =
      [];

    const refused = prepareEditToolMutation(
      { path: "sample.txt", oldString: "old", newString: "replacement" },
      {
        workspaceRoot: workspace,
        captureMutationPresentation: (images) => {
          observed.push(images);
          return false;
        },
      },
    );

    expect(observed).toEqual([
      {
        observedBeforeBytes: Buffer.byteLength(before),
        verifiedInstalledAfterBytes: Buffer.byteLength(after),
      },
    ]);
    expect(refused.presentationObservation).toBeUndefined();

    const accepted = prepareEditToolMutation(
      { path: "sample.txt", oldString: "old", newString: "replacement" },
      {
        workspaceRoot: workspace,
        captureMutationPresentation: () => true,
      },
    );
    expect(accepted.presentationObservation).toEqual({ observedBeforeContent: before });

    const callbackFailure = prepareEditToolMutation(
      { path: "sample.txt", oldString: "old", newString: "replacement" },
      {
        workspaceRoot: workspace,
        captureMutationPresentation: () => {
          throw new Error("optional admission failed");
        },
      },
    );
    expect(callbackFailure.presentationObservation).toBeUndefined();
  });

  it("captures bounded write preimages only after admission and preserves explicit absence", () => {
    const workspace = tempDir("keel-typed-write-presentation-admission-");
    const before = Buffer.from([0x61, 0x00, 0xff, 0x62]);
    const after = "replacement\n";
    writeFileSync(join(workspace, "existing.bin"), before);
    const observed: Array<{ observedBeforeBytes: number; verifiedInstalledAfterBytes: number }> =
      [];

    const accepted = prepareWriteToolMutation(
      { path: "existing.bin", content: after },
      {
        workspaceRoot: workspace,
        captureMutationPresentation: (images) => {
          observed.push(images);
          return true;
        },
      },
    );
    expect(observed).toEqual([
      {
        observedBeforeBytes: before.byteLength,
        verifiedInstalledAfterBytes: Buffer.byteLength(after),
      },
    ]);
    expect(accepted.presentationObservation).toEqual({
      writeObservedBefore: {
        status: "file-observed",
        content: before,
      },
    });

    const refused = prepareWriteToolMutation(
      { path: "existing.bin", content: after },
      { workspaceRoot: workspace, captureMutationPresentation: () => false },
    );
    expect(refused.presentationObservation).toBeUndefined();

    const callbackFailure = prepareWriteToolMutation(
      { path: "existing.bin", content: after },
      {
        workspaceRoot: workspace,
        captureMutationPresentation: () => {
          throw new Error("optional write admission failed");
        },
      },
    );
    expect(callbackFailure.presentationObservation).toBeUndefined();

    const absent = prepareWriteToolMutation(
      { path: "new.txt", content: after },
      { workspaceRoot: workspace, captureMutationPresentation: () => true },
    );
    expect(absent.presentationObservation).toEqual({
      writeObservedBefore: { status: "absent-observed" },
    });
  });

  it("does not retain a write preimage above the presentation ceiling", () => {
    const workspace = tempDir("keel-typed-write-presentation-oversize-");
    const before = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    writeFileSync(join(workspace, "large.txt"), before);
    const observed: Array<{ observedBeforeBytes: number; verifiedInstalledAfterBytes: number }> =
      [];

    const prepared = prepareWriteToolMutation(
      { path: "large.txt", content: "bounded replacement" },
      {
        workspaceRoot: workspace,
        captureMutationPresentation: (images) => {
          observed.push(images);
          return true;
        },
      },
    );

    expect(observed).toEqual([
      {
        observedBeforeBytes: 0,
        verifiedInstalledAfterBytes: Buffer.byteLength("bounded replacement"),
      },
    ]);
    expect(prepared.presentationObservation).toEqual({
      writeObservedBefore: { status: "not-inspected" },
    });
    expect(JSON.stringify(prepared.presentationObservation)).not.toContain(before.toString("hex"));
  });

  it("drops retained write bytes if the opened preimage grows beyond the ceiling after admission", () => {
    const workspace = tempDir("keel-typed-write-presentation-growth-");
    const target = join(workspace, "growing.txt");
    writeFileSync(target, "small");

    const prepared = prepareWriteToolMutation(
      { path: "growing.txt", content: "bounded replacement" },
      {
        workspaceRoot: workspace,
        captureMutationPresentation: () => {
          // Admission observes the descriptor's original bounded size. Mutate the same inode before
          // its hash/read loop to model a concurrent writer without relying on scheduler timing.
          writeFileSync(target, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
          return true;
        },
      },
    );

    if (
      prepared.presentationObservation === undefined ||
      !("writeObservedBefore" in prepared.presentationObservation)
    ) {
      throw new Error("expected write presentation observation");
    }
    expect(prepared.presentationObservation.writeObservedBefore.status).toBe("not-inspected");
    expect("content" in prepared.presentationObservation.writeObservedBefore).toBe(false);
  });

  it("parses write/edit args and returns clean invalid-arg guidance", () => {
    expect(parseWriteArgs({ path: "a.txt", content: "alpha" })).toEqual({
      path: "a.txt",
      content: "alpha",
    });
    expect(parseEditArgs({ path: "a.txt", oldString: "alpha", newString: "beta" })).toEqual({
      path: "a.txt",
      oldString: "alpha",
      newString: "beta",
    });

    expect(() => parseWriteArgs({ path: "a.txt" })).toThrow(TypedToolError);
    expect(() => parseEditArgs({ path: "a.txt", oldString: "same", newString: "same" })).toThrow(
      /no-op/u,
    );
  });

  it("refuses NUL-bearing write content before audit intent or mutation", () => {
    const workspace = tempDir("keel-typed-write-nul-");
    const onBeforeMutate = vi.fn();

    expect(() =>
      executeWriteTool(
        { path: "binary.txt", content: "alpha\0beta" },
        { workspaceRoot: workspace, onBeforeMutate },
      ),
    ).toThrow(/NUL bytes|binary content/u);
    expect(onBeforeMutate).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, "binary.txt"))).toBe(false);
  });

  it("refuses NUL-bearing edit replacement before audit intent or mutation", () => {
    const workspace = tempDir("keel-typed-edit-nul-");
    const onBeforeMutate = vi.fn();
    writeFileSync(join(workspace, "sample.txt"), "alpha beta\n");

    expect(() =>
      executeEditTool(
        { path: "sample.txt", oldString: "alpha", newString: "a\0z" },
        { workspaceRoot: workspace, onBeforeMutate },
      ),
    ).toThrow(/NUL bytes|binary content/u);
    expect(onBeforeMutate).not.toHaveBeenCalled();
    expect(readFileSync(join(workspace, "sample.txt"), "utf8")).toBe("alpha beta\n");
  });

  it("allows write-then-edit and preserves authored read-before-edit state", () => {
    const workspace = tempDir("keel-typed-write-edit-");
    const state = createTypedToolState();

    expect(
      executeWriteTool(
        { path: "draft.txt", content: "alpha BETA gamma" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("write: created 'draft.txt' (16 bytes)");
    expect(
      executeEditTool(
        { path: "draft.txt", oldString: "BETA", newString: "delta" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'draft.txt'");
    expect(readFileSync(join(workspace, "draft.txt"), "utf8")).toBe("alpha delta gamma");
  });

  it("fires onBeforeMutate before a write/edit mutation and skips the mutation if it throws (P1-1)", () => {
    const workspace = tempDir("keel-typed-onbeforemutate-");
    const state = createTypedToolState();
    const calls: string[] = [];

    // write: onBeforeMutate runs before the file is created.
    executeWriteTool(
      { path: "a.txt", content: "one" },
      { workspaceRoot: workspace, state, onBeforeMutate: () => calls.push("write") },
    );
    expect(calls).toEqual(["write"]);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("one");

    // a throwing onBeforeMutate (e.g. audit-write failure) prevents the write entirely.
    expect(() =>
      executeWriteTool(
        { path: "b.txt", content: "two" },
        {
          workspaceRoot: workspace,
          state,
          onBeforeMutate: () => {
            throw new Error("audit failed");
          },
        },
      ),
    ).toThrow("audit failed");
    expect(existsSync(join(workspace, "b.txt"))).toBe(false); // no executed-but-unaudited write

    // edit: onBeforeMutate runs (after read-before-edit passed) before the mutation.
    calls.length = 0;
    executeEditTool(
      { path: "a.txt", oldString: "one", newString: "ONE" },
      { workspaceRoot: workspace, state, onBeforeMutate: () => calls.push("edit") },
    );
    expect(calls).toEqual(["edit"]);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("ONE");
  });

  it("does NOT fire onBeforeMutate when an edit is denied at a runtime check (P1-1 semantics)", () => {
    const workspace = tempDir("keel-typed-onbeforemutate-deny-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "line one\nSECRET\n");
    let fired = false;

    // read-before-edit deny: the mutation point is never reached, so no false intent record fires.
    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "SECRET", newString: "x" },
        { workspaceRoot: workspace, state, onBeforeMutate: () => (fired = true) },
      ),
    ).toThrow(/read .*before editing/i);
    expect(fired).toBe(false);
  });

  it("refuses blind, stale, and unread-range edits without modifying the file", () => {
    const workspace = tempDir("keel-typed-edit-rbe-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "line one\nline two SECRET\nline three OTHER\n");

    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "SECRET", newString: "redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow(/read .*before editing/i);

    expect(
      executeReadTool(
        { path: "notes.txt", offset: 1, limit: 1 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("line one");
    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "SECRET", newString: "redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow(/unread region|target range/i);

    expect(executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace, state })).toContain(
      "SECRET",
    );
    writeFileSync(join(workspace, "notes.txt"), "line one\nline two SECRET changed\n");
    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "SECRET", newString: "redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow(/changed on disk|stale/i);
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe(
      "line one\nline two SECRET changed\n",
    );
  });

  it("uses one generic partial-read edit denial for absent, duplicated, and off-range anchors", () => {
    const workspace = tempDir("keel-typed-edit-partial-oracle-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "visible line\nSECRET\nDUP DUP\n");

    expect(
      executeReadTool(
        { path: "notes.txt", byteOffset: 0, byteLimit: "visible line".length },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("visible line");

    const failures = ["MISSING", "SECRET", "DUP"].map((oldString) => {
      try {
        executeEditTool(
          { path: "notes.txt", oldString, newString: "replacement" },
          { workspaceRoot: workspace, state },
        );
        return "unexpected success";
      } catch (err) {
        return (err as Error).message;
      }
    });

    expect(new Set(failures).size).toBe(1);
    expect(failures[0]).toMatch(/re-read the target range/iu);
    expect(failures[0]).not.toMatch(/oldString not found|matches \d+|unread region|SECRET/u);
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe(
      "visible line\nSECRET\nDUP DUP\n",
    );
  });

  it("fails closed for outside-workspace and symlink-escaped write/edit paths", () => {
    const workspace = tempDir("keel-typed-write-paths-");
    const outside = tempDir("keel-typed-write-outside-");
    writeFileSync(join(outside, "target.txt"), "SECRET");
    symlinkSync(join(outside, "target.txt"), join(workspace, "link.txt"));
    const state = createTypedToolState();

    expect(() =>
      executeWriteTool(
        { path: "../escape.txt", content: "nope" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow(/outside the workspace/i);
    expect(() =>
      executeWriteTool({ path: "link.txt", content: "nope" }, { workspaceRoot: workspace, state }),
    ).toThrow(/outside the workspace/i);
    expect(() =>
      executeEditTool(
        { path: "link.txt", oldString: "SECRET", newString: "redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow(/outside the workspace/i);
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("SECRET");
  });

  it("does not create missing write parents through a symlink-escaped directory prefix", () => {
    const workspace = tempDir("keel-typed-write-parent-symlink-");
    const outside = tempDir("keel-typed-write-parent-symlink-outside-");
    symlinkSync(outside, join(workspace, "link"));

    expect(() =>
      executeWriteTool(
        { path: "link/subdir/notes.txt", content: "nope" },
        { workspaceRoot: workspace },
      ),
    ).toThrow(/outside the workspace/i);

    expect(existsSync(join(outside, "subdir"))).toBe(false);
  });

  it("does not create missing write parents outside when a prefix is swapped before mkdir", () => {
    const workspace = tempDir("keel-typed-write-parent-mkdir-swap-");
    const outside = tempDir("keel-typed-write-parent-mkdir-swap-outside-");
    mkdirSync(join(workspace, "dir"));
    let swapped = false;

    expect(() =>
      executeWriteTool(
        { path: "dir/subdir/notes.txt", content: "nope" },
        {
          workspaceRoot: workspace,
          mkdirSync: (path, options) => {
            if (!swapped) {
              swapped = true;
              renameSync(join(workspace, "dir"), join(workspace, "dir.moved"));
              symlinkSync(outside, join(workspace, "dir"));
            }
            return mkdirSync(path, options);
          },
        },
      ),
    ).toThrow(/changed while being validated|outside the workspace/u);

    expect(existsSync(join(outside, "subdir"))).toBe(false);
    expect(existsSync(join(outside, "subdir", "notes.txt"))).toBe(false);
  });

  it("rechecks write target containment immediately before mutation", () => {
    const workspace = tempDir("keel-typed-write-toctou-");
    const outside = tempDir("keel-typed-write-toctou-outside-");
    const target = join(workspace, "notes.txt");
    const outsideTarget = join(outside, "secret.txt");
    writeFileSync(target, "inside");
    writeFileSync(outsideTarget, "outside");

    expect(() =>
      executeWriteTool(
        { path: "notes.txt", content: "changed" },
        {
          workspaceRoot: workspace,
          realpath: realpathThatMovesTargetAfterValidation(target, outsideTarget),
        },
      ),
    ).toThrow(/outside the workspace|changed/u);
    expect(readFileSync(target, "utf8")).toBe("inside");
    expect(readFileSync(outsideTarget, "utf8")).toBe("outside");
  });

  it("rechecks edit target containment after opening the file and before mutation", () => {
    const workspace = tempDir("keel-typed-edit-toctou-");
    const outside = tempDir("keel-typed-edit-toctou-outside-");
    const target = join(workspace, "notes.txt");
    const outsideTarget = join(outside, "secret.txt");
    const state = createTypedToolState();
    writeFileSync(target, "alpha SECRET omega");
    writeFileSync(outsideTarget, "outside");
    executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace, state });

    let caught: unknown;
    try {
      executeEditTool(
        { path: "notes.txt", oldString: "SECRET", newString: "redacted" },
        {
          workspaceRoot: workspace,
          state,
          realpath: realpathThatMovesTargetAfterValidation(target, outsideTarget),
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypedToolError);
    expect((caught as TypedToolError).code).toBe("TOOL_DENIED");
    expect((caught as Error).message).toMatch(/outside the workspace|changed/u);
    expect(readFileSync(target, "utf8")).toBe("alpha SECRET omega");
    expect(readFileSync(outsideTarget, "utf8")).toBe("outside");
  });

  it("fails closed when a parent directory is swapped to an outside symlink before write temp creation", () => {
    const workspace = tempDir("keel-typed-write-parent-swap-");
    const outside = tempDir("keel-typed-write-parent-swap-outside-");
    mkdirSync(join(workspace, "dir"));
    writeFileSync(join(outside, "notes.txt"), "outside");
    let swapped = false;

    expect(() =>
      executeWriteTool(
        { path: "dir/notes.txt", content: "changed" },
        {
          workspaceRoot: workspace,
          openSync: (path, flags, mode) => {
            if (!swapped && flags === "wx") {
              swapped = true;
              renameSync(join(workspace, "dir"), join(workspace, "dir.moved"));
              symlinkSync(outside, join(workspace, "dir"));
            }
            return openSync(path, flags, mode);
          },
        },
      ),
    ).toThrow(/changed while being validated|outside the workspace/u);

    expect(readFileSync(join(outside, "notes.txt"), "utf8")).toBe("outside");
  });

  it("does not mutate outside if a write parent is relocated after the final pre-rename check", () => {
    const workspace = tempDir("keel-typed-write-parent-relocate-before-rename-");
    const outside = tempDir("keel-typed-write-parent-relocate-before-rename-outside-");
    const workspaceParent = join(workspace, "dir");
    const relocatedParent = join(outside, "relocated-dir");
    const outsideTarget = join(relocatedParent, "notes.txt");
    mkdirSync(workspaceParent);
    let attemptedRename = false;

    let caught: unknown;
    try {
      executeWriteTool(
        { path: "dir/notes.txt", content: "ESCAPED" },
        {
          workspaceRoot: workspace,
          renameSync: (from, to) => {
            attemptedRename = true;
            renameSync(workspaceParent, relocatedParent);
            return renameSync(from, to);
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(attemptedRename).toBe(true);
    expect(caught).toBeInstanceOf(TypedToolError);
    expect((caught as TypedToolError).mutationPossible).toBe(true);
    expect(existsSync(outsideTarget)).toBe(false);
    expect(existsSync(join(workspace, "dir", "notes.txt"))).toBe(false);
  });

  it("marks write mutation-possible if the path-based primitive hits a relocated symlink at rename", () => {
    const workspace = tempDir("keel-typed-write-parent-relocate-symlink-");
    const outside = tempDir("keel-typed-write-parent-relocate-symlink-outside-");
    const workspaceParent = join(workspace, "dir");
    const relocatedParent = join(outside, "relocated-dir");
    const outsideTarget = join(relocatedParent, "notes.txt");
    mkdirSync(workspaceParent);
    let attemptedRename = false;

    let caught: unknown;
    try {
      executeWriteTool(
        { path: "dir/notes.txt", content: "ESCAPED" },
        {
          workspaceRoot: workspace,
          renameSync: (from, to) => {
            attemptedRename = true;
            renameSync(workspaceParent, relocatedParent);
            symlinkSync(relocatedParent, workspaceParent);
            return renameSync(from, to);
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(attemptedRename).toBe(true);
    expect(caught).toBeInstanceOf(TypedToolError);
    expect((caught as TypedToolError).mutationPossible).toBe(true);
    expect(readFileSync(outsideTarget, "utf8")).toBe("ESCAPED");
  });

  it("creates missing parent directories for governed writes", () => {
    const workspace = tempDir("keel-typed-write-missing-parent-");

    expect(
      executeWriteTool(
        { path: "dir/subdir/notes.txt", content: "changed" },
        { workspaceRoot: workspace },
      ),
    ).toBe("write: created 'dir/subdir/notes.txt' (7 bytes)");

    expect(readFileSync(join(workspace, "dir", "subdir", "notes.txt"), "utf8")).toBe("changed");
  });

  it("fails closed when guarded parent creation encounters unstable or invalid parents", () => {
    const workspace = tempDir("keel-typed-write-parent-create-errors-");
    writeFileSync(join(workspace, "file-parent"), "not a directory");

    expect(() =>
      executeWriteTool(
        { path: "file-parent/notes.txt", content: "x" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw errno("ENOENT");
          },
        },
      ),
    ).toThrow("parent path component");
    expect(readFileSync(join(workspace, "file-parent"), "utf8")).toBe("not a directory");

    expect(() =>
      executeWriteTool(
        { path: "missing/notes.txt", content: "x" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw errno("ENOENT");
          },
          mkdirSync: () => {
            throw errno("EACCES");
          },
        },
      ),
    ).toThrow("permission denied");
    expect(existsSync(join(workspace, "missing", "notes.txt"))).toBe(false);

    expect(() =>
      executeWriteTool(
        { path: "vanished/notes.txt", content: "x" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw errno("ENOENT");
          },
          mkdirSync: () => undefined,
        },
      ),
    ).toThrow("parent directory");
    expect(existsSync(join(workspace, "vanished", "notes.txt"))).toBe(false);
  });

  it("marks writes mutation-possible when parent creation partially succeeds before failing", () => {
    const workspace = tempDir("keel-typed-write-parent-partial-create-");
    let mkdirCalls = 0;

    let caught: unknown;
    try {
      executeWriteTool(
        { path: "created/blocked/notes.txt", content: "x" },
        {
          workspaceRoot: workspace,
          mkdirSync: (path, options) => {
            mkdirCalls += 1;
            if (mkdirCalls === 1) return mkdirSync(path, options);
            throw errno("EACCES");
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(mkdirCalls).toBe(2);
    expect(caught).toBeInstanceOf(TypedToolError);
    expect((caught as TypedToolError).mutationPossible).toBe(true);
    expect((caught as Error).message).toContain("target may have changed");
    expect(existsSync(join(workspace, "created"))).toBe(true);
    expect(existsSync(join(workspace, "created", "blocked", "notes.txt"))).toBe(false);
  });

  it("continues safely when a raced mkdir reports EEXIST for a newly contained directory", () => {
    const workspace = tempDir("keel-typed-write-parent-eexist-");

    expect(
      executeWriteTool(
        { path: "dir/notes.txt", content: "ok" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw errno("ENOENT");
          },
          mkdirSync: (path, options) => {
            mkdirSync(path, options);
            throw errno("EEXIST");
          },
        },
      ),
    ).toBe("write: created 'dir/notes.txt' (2 bytes)");
    expect(readFileSync(join(workspace, "dir", "notes.txt"), "utf8")).toBe("ok");
  });

  it("fails closed if a newly created parent resolves outside before the write", () => {
    const workspace = tempDir("keel-typed-write-parent-resolve-outside-");
    const outside = tempDir("keel-typed-write-parent-resolve-outside-target-");
    const outsideReal = realpathSync(outside);

    expect(() =>
      executeWriteTool(
        { path: "dir/notes.txt", content: "x" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw errno("ENOENT");
          },
          realpath: (path) => {
            const real = realpathSync(path);
            return path === "." ? outsideReal : real;
          },
        },
      ),
    ).toThrow(/outside the workspace|changed while being validated/u);
    expect(existsSync(join(workspace, "dir", "notes.txt"))).toBe(false);
    expect(existsSync(join(outside, "notes.txt"))).toBe(false);
  });

  it("marks writes mutation-possible when post-atomic containment recheck fails", () => {
    const workspace = tempDir("keel-typed-write-postcheck-");
    const outside = tempDir("keel-typed-write-postcheck-outside-");
    const target = join(workspace, "created.txt");
    const targetReal = join(realpathSync(workspace), "created.txt");
    const outsideTarget = join(outside, "secret.txt");
    writeFileSync(outsideTarget, "outside");
    const outsideReal = realpathSync(outsideTarget);
    let afterAtomic = false;
    let fsyncCalls = 0;

    let caught: unknown;
    try {
      executeWriteTool(
        { path: "created.txt", content: "new content" },
        {
          workspaceRoot: workspace,
          fsyncSync: (fd) => {
            fsyncCalls += 1;
            fsyncSync(fd);
            if (fsyncCalls === 2) afterAtomic = true;
          },
          realpath: (path) => {
            const real = realpathSync(path);
            return afterAtomic && real === targetReal ? outsideReal : real;
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypedToolError);
    expect((caught as TypedToolError).mutationPossible).toBe(true);
    expect((caught as Error).message).toContain("target may have changed");
    expect(readFileSync(target, "utf8")).toBe("new content");
    expect(readFileSync(outsideTarget, "utf8")).toBe("outside");
  });

  it("fails closed when a parent directory is swapped to a different in-workspace directory", () => {
    const workspace = tempDir("keel-typed-write-parent-swap-inside-");
    mkdirSync(join(workspace, "dir"));
    mkdirSync(join(workspace, "other"));
    let swapped = false;

    expect(() =>
      executeWriteTool(
        { path: "dir/notes.txt", content: "changed" },
        {
          workspaceRoot: workspace,
          openSync: (path, flags, mode) => {
            if (!swapped && flags === "wx") {
              swapped = true;
              renameSync(join(workspace, "dir"), join(workspace, "dir.moved"));
              symlinkSync(join(workspace, "other"), join(workspace, "dir"));
            }
            return openSync(path, flags, mode);
          },
        },
      ),
    ).toThrow(/changed while being validated/u);

    expect(existsSync(join(workspace, "other", "notes.txt"))).toBe(false);
  });

  it("fails closed when a parent directory is swapped to an outside symlink before edit temp creation", () => {
    const workspace = tempDir("keel-typed-edit-parent-swap-");
    const outside = tempDir("keel-typed-edit-parent-swap-outside-");
    const state = createTypedToolState();
    mkdirSync(join(workspace, "dir"));
    writeFileSync(join(workspace, "dir", "notes.txt"), "alpha SECRET omega");
    writeFileSync(join(outside, "notes.txt"), "outside");
    executeReadTool({ path: "dir/notes.txt" }, { workspaceRoot: workspace, state });
    let swapped = false;

    expect(() =>
      executeEditTool(
        { path: "dir/notes.txt", oldString: "SECRET", newString: "redacted" },
        {
          workspaceRoot: workspace,
          state,
          openSync: (path, flags, mode) => {
            if (!swapped && flags === "wx") {
              swapped = true;
              renameSync(join(workspace, "dir"), join(workspace, "dir.moved"));
              symlinkSync(outside, join(workspace, "dir"));
            }
            return openSync(path, flags, mode);
          },
        },
      ),
    ).toThrow(/changed while being validated|outside the workspace/u);

    expect(readFileSync(join(outside, "notes.txt"), "utf8")).toBe("outside");
    expect(readFileSync(join(workspace, "dir.moved", "notes.txt"), "utf8")).toBe(
      "alpha SECRET omega",
    );
  });

  it("marks edit mutation-possible if the path-based primitive hits a relocated symlink at rename", () => {
    const workspace = tempDir("keel-typed-edit-parent-relocate-symlink-");
    const outside = tempDir("keel-typed-edit-parent-relocate-symlink-outside-");
    const workspaceParent = join(workspace, "dir");
    const relocatedParent = join(outside, "relocated-dir");
    const outsideTarget = join(relocatedParent, "notes.txt");
    const state = createTypedToolState();
    mkdirSync(workspaceParent);
    writeFileSync(join(workspaceParent, "notes.txt"), "alpha SECRET omega");
    executeReadTool({ path: "dir/notes.txt" }, { workspaceRoot: workspace, state });
    let attemptedRename = false;

    let caught: unknown;
    try {
      executeEditTool(
        { path: "dir/notes.txt", oldString: "SECRET", newString: "ESCAPED" },
        {
          workspaceRoot: workspace,
          state,
          renameSync: (from, to) => {
            attemptedRename = true;
            renameSync(workspaceParent, relocatedParent);
            symlinkSync(relocatedParent, workspaceParent);
            return renameSync(from, to);
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(attemptedRename).toBe(true);
    expect(caught).toBeInstanceOf(TypedToolError);
    expect((caught as TypedToolError).mutationPossible).toBe(true);
    expect(readFileSync(outsideTarget, "utf8")).toBe("alpha ESCAPED omega");
  });

  it("marks edits mutation-possible when post-atomic containment recheck fails", () => {
    const workspace = tempDir("keel-typed-edit-postcheck-");
    const outside = tempDir("keel-typed-edit-postcheck-outside-");
    const state = createTypedToolState();
    const target = join(workspace, "notes.txt");
    const targetReal = join(realpathSync(workspace), "notes.txt");
    const outsideTarget = join(outside, "secret.txt");
    writeFileSync(target, "alpha SECRET omega");
    writeFileSync(outsideTarget, "outside");
    executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace, state });
    const outsideReal = realpathSync(outsideTarget);
    let afterAtomic = false;
    let fsyncCalls = 0;

    let caught: unknown;
    try {
      executeEditTool(
        { path: "notes.txt", oldString: "SECRET", newString: "redacted" },
        {
          workspaceRoot: workspace,
          state,
          fsyncSync: (fd) => {
            fsyncCalls += 1;
            fsyncSync(fd);
            if (fsyncCalls === 2) afterAtomic = true;
          },
          realpath: (path) => {
            const real = realpathSync(path);
            return afterAtomic && real === targetReal ? outsideReal : real;
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypedToolError);
    expect((caught as TypedToolError).mutationPossible).toBe(true);
    expect((caught as Error).message).toContain("target may have changed");
    expect(readFileSync(target, "utf8")).toBe("alpha redacted omega");
    expect(readFileSync(outsideTarget, "utf8")).toBe("outside");
  });

  it("normalizes write filesystem errors and reports overwrite status", () => {
    const workspace = tempDir("keel-typed-write-errors-");
    writeFileSync(join(workspace, "existing.txt"), "old");

    expect(
      executeWriteTool({ path: "existing.txt", content: "new" }, { workspaceRoot: workspace }),
    ).toBe("write: overwrote 'existing.txt' (3 bytes)");
    expect(readFileSync(join(workspace, "existing.txt"), "utf8")).toBe("new");

    expect(() =>
      executeWriteTool(
        { path: "dir", content: "x" },
        {
          workspaceRoot: workspace,
          stat: () => statLike({ directory: true }),
        },
      ),
    ).toThrow("is a directory");
    expect(() =>
      executeWriteTool(
        { path: "denied.txt", content: "x" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw errno("EACCES");
          },
        },
      ),
    ).toThrow("permission denied");
    expect(() =>
      executeWriteTool(
        { path: "isdir.txt", content: "x" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw errno("EISDIR");
          },
        },
      ),
    ).toThrow("is a directory");
    expect(() =>
      executeWriteTool(
        { path: "unknown.txt", content: "x" },
        {
          workspaceRoot: workspace,
          stat: () => {
            throw new Error("boom");
          },
        },
      ),
    ).toThrow("cannot write 'unknown.txt': boom");
    writeFileSync(join(workspace, "broken"), "not a directory");
    expect(() =>
      executeWriteTool({ path: "broken/child.txt", content: "x" }, { workspaceRoot: workspace }),
    ).toThrow("parent path component");
    expect(() =>
      executeWriteTool(
        { path: "cleanup.txt", content: "x" },
        {
          workspaceRoot: workspace,
          openSync: (path, flags, mode) => openSync(path, flags, mode),
          writeFileSync: () => {
            throw errno("EACCES");
          },
          closeSync: (fd) => {
            fsCloseSync(fd);
            throw new Error("close should be swallowed");
          },
        },
      ),
    ).toThrow("permission denied");
  });

  it("normalizes edit read/write and anchor failures without mutating", () => {
    const workspace = tempDir("keel-typed-edit-errors-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "alpha BETA gamma BETA");
    executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace, state });

    expect(() =>
      executeEditTool(
        { path: "missing.txt", oldString: "x", newString: "y" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow("does not exist");
    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "x", newString: "y" },
        {
          workspaceRoot: workspace,
          state,
          readFile: () => {
            throw errno("ENOTDIR");
          },
        },
      ),
    ).toThrow("parent path component");
    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "x", newString: "y" },
        {
          workspaceRoot: workspace,
          state,
          readFile: () => {
            throw new Error("boom");
          },
        },
      ),
    ).toThrow("cannot read 'notes.txt': boom");
    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "absent", newString: "y" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow("oldString not found");
    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "BETA", newString: "delta" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow("matches 2 times");

    writeFileSync(join(workspace, "single.txt"), "alpha BETA gamma");
    executeReadTool({ path: "single.txt" }, { workspaceRoot: workspace, state });
    expect(() =>
      executeEditTool(
        { path: "single.txt", oldString: "BETA", newString: "delta" },
        {
          workspaceRoot: workspace,
          state,
          renameSync: () => {
            throw errno("EACCES");
          },
        },
      ),
    ).toThrow("cannot write 'single.txt'");
    expect(readFileSync(join(workspace, "single.txt"), "utf8")).toBe("alpha BETA gamma");
  });

  it("allows edit over a previously read slice and preserves partial range state", () => {
    const workspace = tempDir("keel-typed-edit-slice-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "one\ntwo target\nthree\n");

    expect(
      executeReadTool(
        { path: "notes.txt", offset: 2, limit: 1 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("two target");
    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "two target", newString: "second target" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("one\nsecond target\nthree\n");
  });

  it("keeps full-read coverage after a later small-file slice proves the file is unchanged", () => {
    const workspace = tempDir("keel-typed-edit-full-then-slice-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "line one\nline two SECRET\nline three\n");

    expect(executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace, state })).toContain(
      "SECRET",
    );
    expect(
      executeReadTool(
        { path: "notes.txt", offset: 1, limit: 1 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("line one");
    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "SECRET", newString: "redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe(
      "line one\nline two redacted\nline three\n",
    );
  });

  it("preserves known prefix and suffix bytes when editing inside a read slice", () => {
    const workspace = tempDir("keel-typed-edit-slice-middle-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "alpha TARGET omega\noutside\n");

    expect(
      executeReadTool(
        { path: "notes.txt", offset: 1, limit: 1 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("alpha TARGET omega");
    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "TARGET", newString: "redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "alpha", newString: "prefix" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe(
      "prefix redacted omega\noutside\n",
    );
  });

  it("preserves independent known ranges before and after a replaced byte range", () => {
    const workspace = tempDir("keel-typed-edit-independent-ranges-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "AA TARGET ZZ");

    expect(
      executeReadTool(
        { path: "notes.txt", byteOffset: 0, byteLimit: 3 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("AA ");
    expect(
      executeReadTool(
        { path: "notes.txt", byteOffset: 3, byteLimit: 6 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("TARGET");
    expect(
      executeReadTool(
        { path: "notes.txt", byteOffset: 9, byteLimit: 3 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe(" ZZ");

    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "TARGET", newString: "X" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "AA", newString: "BB" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "ZZ", newString: "YY" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("BB X YY");
  });

  it("drops stale range observations when preserving partial state across an edit", () => {
    const workspace = tempDir("keel-typed-edit-drop-stale-range-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "AA TARGET ZZ");

    expect(
      executeReadTool(
        { path: "notes.txt", byteOffset: 0, byteLimit: 3 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("AA ");
    writeFileSync(join(workspace, "notes.txt"), "BB TARGET ZZ");
    expect(
      executeReadTool(
        { path: "notes.txt", byteOffset: 3, byteLimit: 6 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("TARGET");

    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "TARGET", newString: "X" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "BB", newString: "CC" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow(/read the target range/u);
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("BB X ZZ");
  });

  it("clears range state when deleting the only bytes read in that range", () => {
    const workspace = tempDir("keel-typed-edit-delete-only-range-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "TARGET");

    expect(
      executeReadTool(
        { path: "notes.txt", byteOffset: 0, byteLimit: "TARGET".length },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("TARGET");
    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "TARGET", newString: "" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "missing", newString: "next" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow(/read .*before editing/u);
  });

  it("allows edit over a previously read byte slice, including non-ASCII text", () => {
    const workspace = tempDir("keel-typed-edit-byte-slice-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "prefix\ncafe target\ncafé target\nsuffix\n");
    const target = "café target";
    const before = "prefix\ncafe target\n";

    expect(
      executeReadTool(
        {
          path: "notes.txt",
          byteOffset: Buffer.byteLength(before, "utf8"),
          byteLimit: Buffer.byteLength(target, "utf8"),
        },
        { workspaceRoot: workspace, state },
      ),
    ).toBe(target);
    expect(
      executeEditTool(
        { path: "notes.txt", oldString: target, newString: "café redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe(
      "prefix\ncafe target\ncafé redacted\nsuffix\n",
    );
  });

  it("validates sliced edits against the current target range, not unrelated file drift", () => {
    const workspace = tempDir("keel-typed-edit-byte-slice-drift-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "prefix\nTARGET\nsuffix\n");
    const targetOffset = Buffer.byteLength("prefix\n", "utf8");

    expect(
      executeReadTool(
        { path: "notes.txt", byteOffset: targetOffset, byteLimit: "TARGET".length },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("TARGET");

    writeFileSync(join(workspace, "notes.txt"), "changed outside\nTARGET\nsuffix\n");
    expect(() =>
      executeEditTool(
        { path: "notes.txt", oldString: "TARGET", newString: "redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow(/target range/u);

    writeFileSync(join(workspace, "notes.txt"), "prefix\nTARGET\nchanged outside\n");
    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "TARGET", newString: "redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe(
      "prefix\nredacted\nchanged outside\n",
    );
  });

  it("allows edit over a previously read large-file line slice", () => {
    const workspace = tempDir("keel-typed-edit-large-line-slice-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "huge.log"), "header\nTARGET\nfooter\n");

    expect(
      executeReadTool(
        { path: "huge.log", offset: 2, limit: 1 },
        {
          workspaceRoot: workspace,
          state,
          stat: () => statLike({ size: READ_MAX_FILE_BYTES + 1 }),
        },
      ),
    ).toBe("TARGET");
    expect(
      executeEditTool(
        { path: "huge.log", oldString: "TARGET", newString: "redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'huge.log'");
    expect(readFileSync(join(workspace, "huge.log"), "utf8")).toBe("header\nredacted\nfooter\n");
  });

  it("refuses to edit an actual over-cap file after a partial read without mutating", () => {
    const workspace = tempDir("keel-typed-edit-actual-large-deny-");
    const state = createTypedToolState();
    const target = join(workspace, "huge.log");
    const original = `TARGET\n${"x".repeat(READ_MAX_FILE_BYTES + 1)}`;
    writeFileSync(target, original);

    expect(
      executeReadTool(
        { path: "huge.log", offset: 1, limit: 1 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("TARGET");
    expect(() =>
      executeEditTool(
        { path: "huge.log", oldString: "TARGET", newString: "redacted" },
        { workspaceRoot: workspace, state },
      ),
    ).toThrow(/too large to edit/u);
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  it("merges overlapping read slices before checking edit range coverage", () => {
    const workspace = tempDir("keel-typed-edit-merge-");
    const state = createTypedToolState();
    writeFileSync(join(workspace, "notes.txt"), "one\ntwo\nthree\nfour\n");

    expect(
      executeReadTool(
        { path: "notes.txt", offset: 2, limit: 2 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("two\nthree");
    expect(
      executeReadTool(
        { path: "notes.txt", offset: 3, limit: 2 },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("three\nfour");
    expect(
      executeEditTool(
        { path: "notes.txt", oldString: "two\nthree\nfour", newString: "second\nthird\nfourth" },
        { workspaceRoot: workspace, state },
      ),
    ).toBe("edit: replaced 1 occurrence in 'notes.txt'");
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("one\nsecond\nthird\nfourth\n");
  });
});

describe("truncateHeadTail", () => {
  it("returns short text unchanged", () => {
    expect(truncateHeadTail("hello", 1024)).toBe("hello");
  });

  it("actually shrinks large text even at a tiny budget (no subarray(-0) whole-buffer bug)", () => {
    const big = "z".repeat(100_000);
    // maxBytes ≤ 160 drives tailBytes toward 0; the buggy form returns the WHOLE buffer here.
    const out = truncateHeadTail(big, 120);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(Buffer.byteLength(big, "utf8"));
    expect(out).toContain("... [output truncated] ...");
  });

  it("cuts the retained tail on a UTF-8 boundary without replacement characters", () => {
    const out = truncateHeadTail(`start ${"é".repeat(200)} end`, 65);
    expect(out).toContain("... [output truncated] ...");
    expect(out).not.toContain("\uFFFD");
  });
});

describe("redactThenTruncateHeadTail", () => {
  const redact = (s: string): string => s.split("SECRETTOKEN").join("[R]");

  it("is byte-identical to truncateHeadTail when nothing near a cut redacts", () => {
    const text = "a ".repeat(200_000); // ~400 KiB, no secret token anywhere
    expect(redactThenTruncateHeadTail(text, 1000, redact)).toBe(truncateHeadTail(text, 1000));
  });

  it("redacts the whole input when it fits under the budget", () => {
    expect(redactThenTruncateHeadTail("has SECRETTOKEN here", 1024, redact)).toBe("has [R] here");
  });

  it("redacts a secret straddling the HEAD cut before the tail is dropped", () => {
    const headBytes = Math.floor(1000 * 0.6); // 600
    const head = "a".repeat(headBytes - 5); // secret starts 5 bytes before the head cut
    const text = `${head}SECRETTOKEN${"z".repeat(5000)}`;
    const out = redactThenTruncateHeadTail(text, 1000, redact);
    expect(out).not.toContain("SECRET");
    expect(out).toContain("[R]");
  });

  it("redacts a secret straddling the TAIL cut so no suffix fragment survives", () => {
    const maxBytes = 2000;
    const tailBytes = Math.max(1, maxBytes - Math.floor(maxBytes * 0.6) - 64); // 736
    const text = `${"a".repeat(5000)}SECRETTOKEN${"z".repeat(tailBytes - 4)}`; // 4 chars land in kept tail
    const out = redactThenTruncateHeadTail(text, maxBytes, redact);
    expect(out).not.toContain("OKEN"); // the 4-char suffix that the naive form would leak
    expect(out).not.toContain("SECRETTOKEN");
  });
});
