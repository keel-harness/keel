import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { InvalidMatcherPatternError } from "./errors.js";
import { loadScript, parseScriptJson } from "./loader.js";

const VALID = {
  turns: [{ text: "hi", toolCalls: [{ name: "bash", args: { command: "ls" } }] }],
};

describe("script loader", () => {
  it("validates an already-parsed object", () => {
    expect(loadScript(VALID).turns).toHaveLength(1);
  });

  it("rejects a malformed object with a ZodError", () => {
    expect(() => loadScript({ turns: [{ toolCalls: [{ name: "" }] }] })).toThrow(ZodError);
    expect(() => loadScript({ nope: true })).toThrow(ZodError);
  });

  it("parses a JSON string into a validated script", () => {
    expect(parseScriptJson(JSON.stringify(VALID)).turns).toHaveLength(1);
  });

  it("propagates JSON syntax errors", () => {
    expect(() => parseScriptJson("{not json")).toThrow(SyntaxError);
  });

  it("N6: rejects an uncompilable regex pattern with a typed InvalidMatcherPatternError", () => {
    const bad = {
      turns: [
        {
          branches: [{ match: { on: "toolResult", kind: "regex", pattern: "(" }, goto: 0 }],
        },
      ],
    };
    expect(() => loadScript(bad)).toThrow(InvalidMatcherPatternError);
    expect(() => loadScript(bad)).not.toThrow(SyntaxError);
  });

  it("N6: InvalidMatcherPatternError message includes the pattern and provenance location", () => {
    const bad = {
      turns: [
        {
          branches: [{ match: { on: "toolResult", kind: "regex", pattern: "(" }, goto: 0 }],
        },
      ],
    };
    let thrown: unknown;
    try {
      loadScript(bad);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InvalidMatcherPatternError);
    const err = thrown as InvalidMatcherPatternError;
    expect(err.message).toContain("(");
    expect(err.message).toContain("turns[0].branches[0]");
  });

  it("N6: a valid regex pattern still loads successfully", () => {
    const good = {
      turns: [
        {
          branches: [{ match: { on: "toolResult", kind: "regex", pattern: "^done$" }, goto: 0 }],
        },
      ],
    };
    expect(() => loadScript(good)).not.toThrow();
    expect(loadScript(good).turns).toHaveLength(1);
  });
});
