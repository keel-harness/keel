import { describe, expect, it } from "vitest";
import type { ModelMessageT } from "@keel/shared";
import { classify } from "./retention.js";

const m = (role: ModelMessageT["role"], content = ""): ModelMessageT => ({ role, content });

describe("classify (§4.7.2 retention classes, Phase-1 message mapping)", () => {
  it("system messages are pinned (prompt / env snapshot / constraints)", () => {
    expect(classify(m("system"), 99, 6)).toBe("pinned");
  });

  it("the last N turns are recent_verbatim (never cleared), regardless of role", () => {
    expect(classify(m("user"), 0, 6)).toBe("recent_verbatim");
    expect(classify(m("tool"), 5, 6)).toBe("recent_verbatim"); // within the window
  });

  it("an older tool result is clearable; older prose is summarizable", () => {
    expect(classify(m("tool"), 6, 6)).toBe("clearable"); // just outside the verbatim window
    expect(classify(m("assistant"), 10, 6)).toBe("summarizable");
    expect(classify(m("user"), 20, 6)).toBe("summarizable");
  });
});
