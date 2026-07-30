import { describe, expect, it } from "vitest";
import type { SessionEventT } from "@keel/shared";
import { resolveArtifact, createRetrieveTool, RETRIEVE_TOOL_NAME } from "./retrieve.js";

const tr = (id: string, name: string, output: string, isError = false): SessionEventT => ({
  type: "tool_result",
  v: 1,
  ts: "2026-06-19T00:00:00.000Z",
  toolCallId: id,
  name,
  output,
  ...(isError ? { isError: true } : {}),
});

const ledger: SessionEventT[] = [
  { type: "user", v: 1, ts: "2026-06-19T00:00:00.000Z", content: "go" },
  tr("t1", "bash", "line A\nERROR boom\nline C"),
  tr("t2", "search", "a.ts:1:1:x"),
];

describe("resolveArtifact (full output from the ledger — SEC-023 record is canonical)", () => {
  it("finds the full output by toolCallId, preserving name + isError", () => {
    const r = resolveArtifact(ledger, "t1")!;
    expect(r.output).toContain("ERROR boom");
    expect(r.name).toBe("bash");
    expect(r.isError).toBe(false);
  });

  it("returns null for an unknown ref", () => {
    expect(resolveArtifact(ledger, "nope")).toBeNull();
  });
});

describe("retrieve tool", () => {
  const tool = createRetrieveTool(() => ledger);

  it("returns the output with a fail-closed UNTRUSTED provenance header (no trust laundering)", () => {
    const out = tool.handler({ ref: "t1" }) as string;
    expect(out).toContain("ERROR boom"); // the real content
    expect(out).toMatch(/untrusted/i); // provenance: untrusted tool output
    expect(out).toMatch(/trust=unknown|fail-closed/i); // Phase-1 fail-closed
    // DENIED PATH: retrieval must never present the content as trusted. `\b` so this does NOT match
    // the substring inside "un·trusted tool output" (the legitimate fail-closed label).
    expect(out).not.toMatch(/\btrusted tool output|trust=user|trust=workspace/i);
  });

  it("narrows with grep to matching lines", () => {
    const out = tool.handler({ ref: "t1", grep: "error" }) as string;
    expect(out).toContain("ERROR boom");
    expect(out).not.toContain("line A");
  });

  it("a grep that matches NOTHING returns an actionable retry hint, not a blank body", () => {
    const out = tool.handler({ ref: "t1", grep: "zzz-no-such-line" }) as string;
    // names the failed grep, the total line count, and the two next moves (broaden / drop grep)
    expect(out).toContain("zzz-no-such-line");
    expect(out).toMatch(/no lines matched/i);
    expect(out).toMatch(/broaden|drop|omit/i); // tells the model what to do next
    expect(out).toMatch(/3 line/); // there are 3 total lines to see if grep is dropped
  });

  it("caps with maxLines to avoid re-bloating the context", () => {
    const big = createRetrieveTool(() => [
      tr("big", "bash", Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n")),
    ]);
    const out = big.handler({ ref: "big", maxLines: 10 }) as string;
    expect(out).toMatch(/omitted/i);
    expect(out.split("\n").length).toBeLessThan(50);
  });

  it("byte-bounds a single extremely wide retrieved line without changing the raw ledger output", () => {
    const wide = `head-${"x".repeat(120_000)}-tail`;
    const wideTool = createRetrieveTool(() => [tr("wide", "bash", wide)]);
    const out = wideTool.handler({ ref: "wide" }) as string;

    expect(resolveArtifact([tr("wide", "bash", wide)], "wide")?.output).toBe(wide);
    expect(out).toContain("head-");
    expect(out).toContain("-tail");
    expect(out).toMatch(/bytes elided|byte-capped/i);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(40_000);
  });

  it("preserves middle diagnostic samples when byte-capping a large retrieved output", () => {
    const noisy = [
      "head-start",
      ...Array.from({ length: 3000 }, (_, i) => `compile noise before ${i} ${"x".repeat(20)}`),
      "Traceback (most recent call last):",
      '  File "build.py", line 42, in <module>',
      "ERROR critical middle diagnostic",
      ...Array.from({ length: 3000 }, (_, i) => `compile noise after ${i} ${"y".repeat(20)}`),
      "tail-end",
    ].join("\n");
    const noisyTool = createRetrieveTool(() => [tr("noisy", "bash", noisy)]);
    const out = noisyTool.handler({ ref: "noisy", maxLines: 7000 }) as string;

    expect(resolveArtifact([tr("noisy", "bash", noisy)], "noisy")?.output).toBe(noisy);
    expect(out).toMatch(/byte-capped/i);
    expect(out).toMatch(/diagnostic-sampled/i);
    expect(out).toContain("Traceback (most recent call last):");
    expect(out).toContain("ERROR critical middle diagnostic");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(40_000);
  });

  it("gives an honest not-found message for an unknown ref", () => {
    const out = tool.handler({ ref: "ghost" }) as string;
    expect(out).toMatch(/no artifact|not a recorded tool result/i);
    expect(out).toContain("ghost");
  });

  it("is non-mutating and named 'retrieve'", () => {
    expect(tool.staticCapability).toEqual({
      toolName: RETRIEVE_TOOL_NAME,
      effectEnvelope: ["fs_read"],
      broad: false,
    });
    expect(tool.spec.name).toBe(RETRIEVE_TOOL_NAME);
  });

  it("ALWAYS tags retrieved content with fail-closed provenance (over every recorded ref)", () => {
    for (const id of ["t1", "t2"]) {
      const out = tool.handler({ ref: id }) as string;
      expect(out).toMatch(/untrusted/i); // never absent — the no-laundering structural guarantee
    }
  });

  it("surfaces isError in the header for a failed tool result", () => {
    const errTool = createRetrieveTool(() => [tr("e1", "bash", "boom", true)]);
    const out = errTool.handler({ ref: "e1" }) as string;
    expect(out).toContain("isError=true");
    expect(out).toMatch(/untrusted/i);
  });

  it("combines grep and maxLines (capped slice over matched lines)", () => {
    const many = createRetrieveTool(() => [
      tr("m", "bash", Array.from({ length: 100 }, (_, i) => `hit ${i}`).join("\n")),
    ]);
    const out = many.handler({ ref: "m", grep: "hit", maxLines: 6 }) as string;
    expect(out).toMatch(/omitted/i);
    expect(out).toMatch(/matched/i);
  });
});
