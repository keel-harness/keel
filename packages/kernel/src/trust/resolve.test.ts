import { describe, expect, it } from "vitest";
import { resolveWorkspaceTrust } from "./resolve.js";

describe("resolveWorkspaceTrust — the workspace trust decision (walking skeleton: flag + env + default)", () => {
  it("defaults to UNTRUSTED when there is no human, no flag, and no env opt-in (fail closed)", async () => {
    expect(await resolveWorkspaceTrust({ cwd: "/ws", env: {} })).toBe("untrusted");
  });

  it("KEEL_TRUST=1 is an explicit human opt-in → trusted", async () => {
    expect(await resolveWorkspaceTrust({ cwd: "/ws", env: { KEEL_TRUST: "1" } })).toBe("trusted");
  });

  it("a truthy --trust flag is an explicit human opt-in → trusted", async () => {
    expect(await resolveWorkspaceTrust({ cwd: "/ws", env: {}, trustFlag: true })).toBe("trusted");
  });

  it("KEEL_TRUST set to anything other than '1' is NOT trust (no fuzzy truthiness)", async () => {
    expect(await resolveWorkspaceTrust({ cwd: "/ws", env: { KEEL_TRUST: "0" } })).toBe("untrusted");
    expect(await resolveWorkspaceTrust({ cwd: "/ws", env: { KEEL_TRUST: "true" } })).toBe(
      "untrusted",
    );
  });

  it("honors a persisted 'trusted' decision without any flag/env (no re-prompt)", async () => {
    expect(
      await resolveWorkspaceTrust({ cwd: "/ws", env: {}, loadPersisted: () => "trusted" }),
    ).toBe("trusted");
  });

  it("honors a persisted 'untrusted' decision", async () => {
    expect(
      await resolveWorkspaceTrust({ cwd: "/ws", env: {}, loadPersisted: () => "untrusted" }),
    ).toBe("untrusted");
  });

  it("an explicit opt-in (--trust / KEEL_TRUST) overrides a persisted 'untrusted'", async () => {
    expect(
      await resolveWorkspaceTrust({
        cwd: "/ws",
        env: { KEEL_TRUST: "1" },
        loadPersisted: () => "untrusted",
      }),
    ).toBe("trusted");
    expect(
      await resolveWorkspaceTrust({
        cwd: "/ws",
        env: {},
        trustFlag: true,
        loadPersisted: () => "untrusted",
      }),
    ).toBe("trusted");
  });

  it("falls through to untrusted when nothing is persisted and there is no opt-in", async () => {
    expect(
      await resolveWorkspaceTrust({ cwd: "/ws", env: {}, loadPersisted: () => undefined }),
    ).toBe("untrusted");
  });

  it("interactive (TTY): a 'yes' prompt → trusted, and the decision is persisted", async () => {
    const persisted: Array<[string, string]> = [];
    const decision = await resolveWorkspaceTrust({
      cwd: "/ws",
      env: {},
      isTTY: true,
      prompt: async () => true,
      persist: (root, d) => persisted.push([root, d]),
    });
    expect(decision).toBe("trusted");
    expect(persisted).toEqual([["/ws", "trusted"]]);
  });

  it("interactive (TTY): a 'no' prompt → untrusted, and the decline is persisted", async () => {
    const persisted: Array<[string, string]> = [];
    const decision = await resolveWorkspaceTrust({
      cwd: "/ws",
      env: {},
      isTTY: true,
      prompt: async () => false,
      persist: (root, d) => persisted.push([root, d]),
    });
    expect(decision).toBe("untrusted");
    expect(persisted).toEqual([["/ws", "untrusted"]]);
  });

  it("non-interactive: the prompt is NEVER called even if supplied (fail closed)", async () => {
    let asked = false;
    const decision = await resolveWorkspaceTrust({
      cwd: "/ws",
      env: {},
      isTTY: false,
      prompt: async () => {
        asked = true;
        return true;
      },
    });
    expect(decision).toBe("untrusted");
    expect(asked).toBe(false);
  });

  it("a persisted decision is honored WITHOUT prompting (order: persisted before prompt)", async () => {
    let asked = false;
    const decision = await resolveWorkspaceTrust({
      cwd: "/ws",
      env: {},
      isTTY: true,
      loadPersisted: () => "trusted",
      prompt: async () => {
        asked = true;
        return false;
      },
    });
    expect(decision).toBe("trusted");
    expect(asked).toBe(false);
  });

  it("falls back to process.env when no env is supplied (here: no KEEL_TRUST → untrusted)", async () => {
    const prev = process.env["KEEL_TRUST"];
    delete process.env["KEEL_TRUST"];
    try {
      expect(await resolveWorkspaceTrust({ cwd: "/ws" })).toBe("untrusted");
    } finally {
      if (prev !== undefined) process.env["KEEL_TRUST"] = prev;
    }
  });
});
