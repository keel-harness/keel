import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { interpretTrustAnswer, readTrustLine, trustPromptText } from "./trust-prompt.js";

describe("trustPromptText — the first-open trust prompt (Appendix G item 1; honest governed-mode copy)", () => {
  const text = trustPromptText("/home/me/project");

  it("asks the trust question and shows the exact workspace", () => {
    expect(text).toMatch(/trust this workspace/i);
    expect(text).toContain("/home/me/project");
  });

  it("states what trust unlocks (project context: AGENTS.md / skills / files)", () => {
    expect(text).toMatch(/AGENTS\.md/);
    expect(text).toMatch(/skill/i);
  });

  it("is HONEST about the shipped governed surface (bash + file tools) and makes NO false protection claim", () => {
    // Governed mode routes bash AND the trusted file tools (read/search/write/edit) through the
    // warden since Epic 2.15 — the copy must not still say typed tools fail closed / the bridge is
    // future work (that stale Phase-2A copy contradicts --help and the README).
    expect(text).toMatch(/bash/i);
    expect(text).toMatch(/read[\s\S]*search[\s\S]*write[\s\S]*edit/i); // list may wrap across lines
    expect(text).toMatch(/through the warden/i);
    expect(text).not.toMatch(/other typed tools fail closed/i);
    expect(text).not.toMatch(/typed-tool bridge/i);
    expect(text).not.toMatch(/Phase 2A/i);
    // Still no over-claim of containment beyond what's enforced.
    expect(text).not.toMatch(/\bprotected\b/i);
    expect(text).not.toMatch(/\bisolated\b/i);
    expect(text).not.toMatch(/all tools/i);
  });

  it("tells the user that declining keeps the agent functional with empty context", () => {
    expect(text).toMatch(/decline/i);
    expect(text).toMatch(/empty/i);
  });

  it("tells the user the decision is remembered (it persists user-scope)", () => {
    expect(text).toMatch(/remember/i);
    expect(text).not.toMatch(/change it any time/i);
  });
});

describe("readTrustLine — direct TTY handoff", () => {
  it("reads one answer from its dedicated stream and returns pasted composer bytes for handoff", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let prompt = "";
    output.on("data", (chunk: unknown) => {
      prompt += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    });

    const answer = readTrustLine(input, output);
    expect(input.readableFlowing).not.toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    input.write("y\r\n/about\r\n");

    const read = await answer;
    expect(read.answer).toBe("y");
    expect(read.remainder.toString()).toBe("/about\r\n");
    expect(prompt).toBe("> ");
    expect(input.destroyed).toBe(false);
    expect(input.readableFlowing).not.toBe(true);
    expect(input.listenerCount("readable")).toBe(0);
    input.destroy();
    output.destroy();
  });

  it("uses the final unterminated bytes when the input reaches EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = readTrustLine(input, output, "trust> ");

    input.end("n");

    await expect(answer).resolves.toEqual({ answer: "n", remainder: Buffer.alloc(0) });
    input.destroy();
    output.destroy();
  });

  it("preserves pasted remainder bytes even when a UTF-8 code point is split across reads", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = readTrustLine(input, output);

    const partialEmoji = Buffer.from([0xf0, 0x9f]);
    input.write(Buffer.concat([Buffer.from("y\n"), partialEmoji]));

    const read = await answer;
    expect(read.answer).toBe("y");
    expect(read.remainder).toEqual(partialEmoji);
    input.destroy();
    output.destroy();
  });

  it("rejects an input-stream error without leaving prompt listeners installed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = readTrustLine(input, output);

    input.destroy(new Error("trust input failed"));

    await expect(answer).rejects.toThrow("trust input failed");
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("readable")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    output.destroy();
  });
});

describe("interpretTrustAnswer — only an explicit yes trusts; everything else declines (fail closed)", () => {
  it("treats y / yes (any case, trimmed) as trust", () => {
    for (const a of ["y", "Y", "yes", "YES", " Yes "]) expect(interpretTrustAnswer(a)).toBe(true);
  });

  it("treats empty / n / anything else as decline (the default is decline)", () => {
    for (const a of ["", " ", "n", "no", "nope", "sure", "1", "yy"]) {
      expect(interpretTrustAnswer(a)).toBe(false);
    }
  });
});
