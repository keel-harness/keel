import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { keelHome, sessionPath, sessionsDir } from "./paths.js";

describe("keel paths", () => {
  it("honors KEEL_HOME first", () => {
    expect(keelHome({ KEEL_HOME: "/tmp/k", XDG_CONFIG_HOME: "/x", HOME: "/home/u" })).toBe(
      "/tmp/k",
    );
  });

  it("falls back to XDG_CONFIG_HOME/keel", () => {
    expect(keelHome({ XDG_CONFIG_HOME: "/x", HOME: "/home/u" })).toBe(join("/x", "keel"));
  });

  it("falls back to ~/.config/keel", () => {
    expect(keelHome({ HOME: "/home/u" })).toBe(join("/home/u", ".config", "keel"));
  });

  const VALID_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

  it("sessionsDir = <home>/sessions and sessionPath appends <id>.jsonl", () => {
    expect(sessionsDir({ KEEL_HOME: "/k" })).toBe(join("/k", "sessions"));
    expect(sessionPath(VALID_ID, { KEEL_HOME: "/k" })).toBe(
      join("/k", "sessions", `${VALID_ID}.jsonl`),
    );
  });

  it("uses os.homedir() when HOME is unset", () => {
    // no KEEL_HOME / XDG_CONFIG_HOME / HOME → falls back to homedir()/.config/keel
    expect(keelHome({})).toContain(join(".config", "keel"));
  });

  it("defaults to process.env when no env is passed", () => {
    expect(typeof keelHome()).toBe("string");
    expect(sessionsDir()).toContain("sessions");
    expect(sessionPath(VALID_ID)).toContain(`${VALID_ID}.jsonl`);
  });

  // Security: a session id is opaque (ses_<ULID>), never a path. Reject anything else
  // BEFORE it reaches the filesystem, so a crafted id cannot traverse out of the dir.
  it("rejects a path-traversal / non-SessionId id", () => {
    expect(() => sessionPath("../../etc/passwd", { KEEL_HOME: "/k" })).toThrow(
      /invalid session id/i,
    );
    expect(() => sessionPath("ses_x", { KEEL_HOME: "/k" })).toThrow(/invalid session id/i);
    expect(() => sessionPath("/etc/passwd", { KEEL_HOME: "/k" })).toThrow(/invalid session id/i);
    expect(() => sessionPath("..", { KEEL_HOME: "/k" })).toThrow(/invalid session id/i);
  });
});
