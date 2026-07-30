import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { isInside } from "./path-util.js";

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
