import { describe, expect, it } from "vitest";
import { KernelEvent } from "./events.js";
import {
  copyToolPresentationOutcome,
  markToolControlFailure,
  markToolPresentationOutcome,
  toolPresentationOutcome,
  toolControlFailureCode,
} from "./tool-presentation-outcome.js";

describe("tool presentation outcome metadata", () => {
  it("is kernel-local and cannot cross JSON or schema boundaries", () => {
    const event = markToolPresentationOutcome(
      {
        type: "tool-result" as const,
        id: "call-1",
        ok: false,
        output: "failed",
      },
      "blocked",
    );

    expect(toolPresentationOutcome(event)).toBe("blocked");

    const jsonRoundTrip = JSON.parse(JSON.stringify(event)) as object;
    expect(toolPresentationOutcome(jsonRoundTrip)).toBeUndefined();

    const schemaRoundTrip = KernelEvent.parse(event);
    expect(toolPresentationOutcome(schemaRoundTrip)).toBeUndefined();
  });

  it("copies only explicit kernel-local outcome metadata", () => {
    const untaggedTarget = { ok: true };
    expect(copyToolPresentationOutcome({}, untaggedTarget)).toBe(untaggedTarget);
    expect(toolPresentationOutcome(untaggedTarget)).toBeUndefined();

    const taggedTarget = copyToolPresentationOutcome(markToolPresentationOutcome({}, "limited"), {
      ok: true,
    });
    expect(toolPresentationOutcome(taggedTarget)).toBe("limited");
  });

  it("keeps control-plane failure metadata kernel-local", () => {
    const tagged = markToolControlFailure({ ok: false }, "TIER_UNAVAILABLE");
    expect(toolControlFailureCode(tagged)).toBe("TIER_UNAVAILABLE");
    expect(toolControlFailureCode(JSON.parse(JSON.stringify(tagged)) as object)).toBeUndefined();
  });
});
