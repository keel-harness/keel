import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { keelHome } from "./keel-home.js";

describe("keelHome (canonical state-dir resolution — single source of truth for kernel + warden)", () => {
  it("returns an absolute KEEL_HOME unchanged (resolve is idempotent)", () => {
    expect(keelHome({ KEEL_HOME: "/srv/keel" })).toBe("/srv/keel");
  });

  it("resolves a relative KEEL_HOME to absolute against cwd", () => {
    expect(keelHome({ KEEL_HOME: "relstate" })).toBe(resolve("relstate"));
  });

  it("trims surrounding whitespace and normalizes a trailing slash", () => {
    expect(keelHome({ KEEL_HOME: "  /srv/keel/  " })).toBe("/srv/keel");
  });

  it("treats a whitespace-only KEEL_HOME as UNSET (not a directory literally named with spaces)", () => {
    expect(keelHome({ KEEL_HOME: "   ", HOME: "/home/alice" })).toBe(
      resolve("/home/alice", ".config", "keel"),
    );
  });

  it("falls back to $XDG_CONFIG_HOME/keel when KEEL_HOME is unset", () => {
    expect(keelHome({ XDG_CONFIG_HOME: "/xdg" })).toBe(resolve("/xdg", "keel"));
  });

  it("falls back to $HOME/.config/keel when KEEL_HOME and XDG are unset", () => {
    expect(keelHome({ HOME: "/home/bob" })).toBe(resolve("/home/bob", ".config", "keel"));
  });

  it("falls back to os.homedir() when HOME is missing, empty, or whitespace-only", () => {
    const expected = resolve(homedir(), ".config", "keel");
    expect(keelHome({})).toBe(expected);
    expect(keelHome({ HOME: "" })).toBe(expected);
    expect(keelHome({ HOME: "   " })).toBe(expected);
  });

  it("orders precedence KEEL_HOME > XDG_CONFIG_HOME > HOME", () => {
    expect(keelHome({ KEEL_HOME: "/k", XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/k");
    expect(keelHome({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe(resolve("/x", "keel"));
  });

  // The load-bearing cross-process property: the kernel resolves KEEL_HOME once and passes the
  // ABSOLUTE result to the warden's spawn env; the warden re-resolving that value must be a no-op,
  // so the two processes can never disagree on where state lives (P1-11).
  it("is idempotent — re-resolving its own output yields the identical path", () => {
    for (const env of [
      { KEEL_HOME: "relstate" },
      { KEEL_HOME: "  /srv/keel/  " },
      { XDG_CONFIG_HOME: "/xdg" },
      { HOME: "/home/carol" },
      {},
    ]) {
      const once = keelHome(env);
      expect(keelHome({ KEEL_HOME: once })).toBe(once);
    }
  });
});
