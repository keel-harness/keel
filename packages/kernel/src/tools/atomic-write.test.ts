import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicWriteError, atomicWrite } from "./atomic-write.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keel-aw-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("creates a new file with the content", () => {
    atomicWrite(join(root, "a.txt"), "hello");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello");
  });

  it("creates parent directories (mkdir -p)", () => {
    atomicWrite(join(root, "a/b/c.txt"), "deep");
    expect(readFileSync(join(root, "a/b/c.txt"), "utf8")).toBe("deep");
  });

  it("overwrites an existing file", () => {
    writeFileSync(join(root, "a.txt"), "old");
    atomicWrite(join(root, "a.txt"), "new");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new");
  });

  it("on write failure leaves the target untouched and no temp orphan (atomicity)", () => {
    const target = join(root, "a.txt");
    writeFileSync(target, "ORIGINAL");
    const boom = (): never => {
      throw new Error("disk full");
    };
    expect(() => atomicWrite(target, "NEW", { writeFileSync: boom })).toThrow(/disk full/);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL"); // unchanged
    expect(readdirSync(root)).toEqual(["a.txt"]); // no .tmp orphan
  });

  it("preserves the primary write error if cleanup close also fails", () => {
    const target = join(root, "a.txt");
    writeFileSync(target, "ORIGINAL");

    expect(() =>
      atomicWrite(target, "NEW", {
        openSync: () => 1,
        writeFileSync: () => {
          throw new Error("disk full");
        },
        closeSync: () => {
          throw new Error("close failed");
        },
      }),
    ).toThrow(/disk full/);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
    expect(readdirSync(root)).toEqual(["a.txt"]);
  });

  it("on rename failure leaves the target untouched and cleans the temp", () => {
    const target = join(root, "a.txt");
    writeFileSync(target, "ORIGINAL");
    const boom = (): never => {
      throw new Error("rename failed");
    };
    expect(() => atomicWrite(target, "NEW", { renameSync: boom })).toThrow(/rename failed/);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
    expect(readdirSync(root)).toEqual(["a.txt"]);
  });

  it("marks failures after rename as mutation-possible because the target changed", () => {
    const target = join(root, "a.txt");
    writeFileSync(target, "ORIGINAL");
    let fsyncCalls = 0;

    let caught: unknown;
    try {
      atomicWrite(target, "NEW", {
        fsyncSync: () => {
          fsyncCalls += 1;
          if (fsyncCalls === 2) throw new Error("directory fsync failed");
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AtomicWriteError);
    expect((caught as AtomicWriteError).mutationPossible).toBe(true);
    expect((caught as Error).message).toContain("directory fsync failed");
    expect(readFileSync(target, "utf8")).toBe("NEW");
  });

  it("fsyncs the temp file before rename and the parent directory after rename", () => {
    const calls: string[] = [];
    atomicWrite(
      join(root, "a.txt"),
      "durable",
      {
        mkdirSync: () => calls.push("mkdir"),
        openSync: (path, flags) => {
          calls.push(flags === "r" ? `open-dir:${path}` : `open-file:${path}`);
          return flags === "r" ? 2 : 1;
        },
        writeFileSync: (fd, data) => calls.push(`write:${String(fd)}:${data}`),
        fsyncSync: (fd) => calls.push(`fsync:${String(fd)}`),
        closeSync: (fd) => calls.push(`close:${String(fd)}`),
        renameSync: () => calls.push("rename"),
      },
      0o600,
    );

    expect(calls).toEqual([
      "mkdir",
      expect.stringMatching(/^open-file:/),
      "write:1:durable",
      "fsync:1",
      "close:1",
      "rename",
      expect.stringMatching(/^open-dir:/),
      "fsync:2",
      "close:2",
    ]);
  });

  describe("mode (owner-only credential writes — Epic 1.9 QC)", () => {
    it("creates the file with the requested mode (0600), surviving the temp+rename", () => {
      const target = join(root, "secret.json");
      atomicWrite(target, "{}", {}, 0o600);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    });

    it("writes 0600 even when a leftover loose-perm temp exists (unique-temp + exclusive create)", () => {
      const target = join(root, "secret.json");
      // A crashed write under a different umask, or a planted file, leaves a loose-perm sibling temp.
      // The fixed-name approach would write into it and inherit 0644; the unique temp must ignore it.
      writeFileSync(join(root, `.secret.json.dead.tmp`), "leftover", { mode: 0o644 });
      atomicWrite(target, '{"k":"v"}', {}, 0o600);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readFileSync(target, "utf8")).toBe('{"k":"v"}');
    });

    it("does not follow a symlink planted at a predictable temp path (no write-through)", () => {
      const target = join(root, "secret.json");
      const victim = join(root, "victim.txt");
      writeFileSync(victim, "UNTOUCHED");
      // Pre-plant the *legacy* predictable temp name as a symlink to a victim file.
      symlinkSync(victim, join(root, "secret.json.tmp"));
      atomicWrite(target, '{"k":"leak?"}', {}, 0o600);
      expect(readFileSync(victim, "utf8")).toBe("UNTOUCHED"); // secret never written through the symlink
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    });
  });
});
