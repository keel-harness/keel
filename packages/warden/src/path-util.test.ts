import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { isInside, isInsideCanonical } from "./path-util.js";

describe("isInside", () => {
  it("treats a path as inside its own root", () => {
    expect(isInside("/workspace", "/workspace")).toBe(true);
  });

  it("treats a descendant path as inside the root", () => {
    expect(isInside("/workspace", "/workspace/src/index.ts")).toBe(true);
  });

  it("treats an unrelated path as outside the root", () => {
    expect(isInside("/workspace", "/etc/passwd")).toBe(false);
  });

  it("does not treat a sibling whose name shares a prefix as inside (no /a/bc in /a/b)", () => {
    expect(isInside("/a/b", "/a/bc")).toBe(false);
  });

  it("resolves relative roots and candidates to absolute paths before comparing", () => {
    expect(isInside(".", resolve(".", "child"))).toBe(true);
    expect(isInside("a/b", "a/b/../c")).toBe(false);
  });
});

describe("isInsideCanonical", () => {
  // `isInside` is a byte comparison of two `resolve()`d strings. Every deny decision that used it
  // could be evaded by spelling the same file differently: through a symlink, through the macOS
  // /var -> /private/var alias, by changing case on a case-insensitive volume, or by swapping
  // Unicode normalization form. This comparator canonicalizes BOTH sides so the comparison is
  // about the file, not the spelling.
  let dir: string;

  it("matches a denied file reached through an in-workspace symlink", () => {
    dir = mkdtempSync(join(tmpdir(), "keel-canon-"));
    try {
      mkdirSync(join(dir, "secrets"), { recursive: true });
      const denied = join(dir, "secrets", "token");
      writeFileSync(denied, "canary\n");
      const link = join(dir, "notes.txt");
      symlinkSync(denied, link);

      expect(isInside(denied, link)).toBe(false);
      expect(isInsideCanonical(denied, link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches across a symlinked ancestor such as the macOS /var alias", () => {
    dir = mkdtempSync(join(tmpdir(), "keel-canon-alias-"));
    try {
      const real = join(dir, "secrets");
      mkdirSync(real, { recursive: true });
      const denied = join(real, "token");
      writeFileSync(denied, "canary\n");
      const aliasDir = join(dir, "alias");
      symlinkSync(real, aliasDir);
      const viaAlias = join(aliasDir, "token");

      expect(isInside(denied, viaAlias)).toBe(false);
      expect(isInsideCanonical(denied, viaAlias)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches a case variant of a denied root", () => {
    expect(isInside("/workspace/.env", "/workspace/.ENV")).toBe(false);
    expect(isInsideCanonical("/workspace/.env", "/workspace/.ENV")).toBe(true);
    expect(isInsideCanonical("/workspace/.env", "/WORKSPACE/.Env")).toBe(true);
  });

  it("matches a Unicode NFD spelling of an NFC denied root", () => {
    const nfc = "/workspace/confé/secret";
    const nfd = "/workspace/confé/secret";
    expect(isInside(nfc, nfd)).toBe(false);
    expect(isInsideCanonical(nfc, nfd)).toBe(true);
  });

  it("still rejects a genuinely unrelated path and a shared-prefix sibling", () => {
    expect(isInsideCanonical("/workspace", "/etc/passwd")).toBe(false);
    expect(isInsideCanonical("/a/b", "/a/bc")).toBe(false);
  });

  it("falls back to a lexical comparison when neither side exists on disk", () => {
    expect(isInsideCanonical("/nonexistent/root", "/nonexistent/root/child")).toBe(true);
  });
});
