import { fsyncSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { atomicWriteFile, type AtomicWriteDeps } from "./atomic-write.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "keel-aw-"));
}

describe("atomicWriteFile", () => {
  it("writes content and leaves no temp files behind", () => {
    const dir = tmp();
    const target = join(dir, "store.json");
    atomicWriteFile(target, '{"v":1}', 0o600);
    expect(readFileSync(target, "utf8")).toBe('{"v":1}');
    expect(readdirSync(dir)).toEqual(["store.json"]);
  });

  it("applies the requested mode on creation", () => {
    const target = join(tmp(), "store.json");
    atomicWriteFile(target, "x", 0o600);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("overwrites an existing target atomically", () => {
    const dir = tmp();
    const target = join(dir, "store.json");
    atomicWriteFile(target, "one", 0o600);
    atomicWriteFile(target, "two", 0o600);
    expect(readFileSync(target, "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["store.json"]);
  });

  it("removes the temp and rethrows when the write fails after opening (no leaked temp)", () => {
    const rm = vi.fn();
    const closed: number[] = [];
    const deps: AtomicWriteDeps = {
      mkdirSync: () => {},
      openSync: () => 7,
      writeFileSync: () => {
        throw new Error("ENOSPC");
      },
      fsyncSync: () => {},
      closeSync: (fd) => closed.push(fd),
      renameSync: () => {},
      rmSync: rm,
    };
    expect(() => atomicWriteFile("/x/store.json", "data", 0o600, deps)).toThrow("ENOSPC");
    expect(rm).toHaveBeenCalledTimes(1); // temp cleaned up
    expect(closed).toContain(7); // the open fd was closed in cleanup
  });

  it("preserves the original error if closing the fd during cleanup also throws", () => {
    const deps: AtomicWriteDeps = {
      mkdirSync: () => {},
      openSync: () => 9,
      writeFileSync: () => {
        throw new Error("primary write failure");
      },
      fsyncSync: () => {},
      closeSync: () => {
        throw new Error("secondary close failure");
      },
      renameSync: () => {},
      rmSync: () => {},
    };
    expect(() => atomicWriteFile("/x/store.json", "data", 0o600, deps)).toThrow(
      "primary write failure",
    );
  });

  it("uses the default rmSync cleanup when no rmSync dep is injected", () => {
    // Everything overridden EXCEPT rmSync, so the failure path runs the real default cleanup (harmless
    // on the non-existent temp thanks to force:true).
    const deps: AtomicWriteDeps = {
      mkdirSync: () => {},
      openSync: () => 7,
      writeFileSync: () => {
        throw new Error("boom");
      },
      fsyncSync: () => {},
      closeSync: () => {},
      renameSync: () => {},
    };
    expect(() => atomicWriteFile(join(tmp(), "store.json"), "data", 0o600, deps)).toThrow("boom");
  });

  it("reports a replaced target when parent-dir fsync fails after rename", () => {
    const dir = tmp();
    const target = join(dir, "store.json");
    let fsyncs = 0;
    const deps: AtomicWriteDeps = {
      fsyncSync: (fd) => {
        fsyncs += 1;
        if (fsyncs === 2) throw new Error("dir fsync failed");
        fsyncSync(fd);
      },
    };
    expect(atomicWriteFile(target, "data", 0o600, deps)).toBe("replaced");
    expect(readFileSync(target, "utf8")).toBe("data");
    expect(readdirSync(dir)).toEqual(["store.json"]);
  });

  it("does not let failed temp cleanup hide a replacement that already happened", () => {
    let fsyncs = 0;
    const deps: AtomicWriteDeps = {
      mkdirSync: () => {},
      openSync: (_path, flags) => (flags === "wx" ? 7 : 8),
      writeFileSync: () => {},
      fsyncSync: () => {
        fsyncs += 1;
        if (fsyncs === 2) throw new Error("dir fsync failed");
      },
      closeSync: () => {},
      renameSync: () => {},
      rmSync: () => {
        throw new Error("temp cleanup failed");
      },
    };

    expect(atomicWriteFile("/x/store.json", "data", 0o600, deps)).toBe("replaced");
  });
});
