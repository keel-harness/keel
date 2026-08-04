import { describe, expect, it } from "vitest";
import { assertWireRoundTrips } from "@keel/shared/testing";
import {
  BLOCKED_AFTER_SYNTHESIS_CODE,
  BLOCKED_AFTER_SYNTHESIS_MESSAGE,
  REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
  KernelEvent,
  StopReason,
  stopCodeNeedsAttention,
  stopReasonForLoopStopped,
} from "./events.js";

describe("KernelEvent vocabulary", () => {
  it("parses every variant", () => {
    const variants = [
      { type: "run-started" },
      { type: "turn-started", turn: 1 },
      { type: "final-answer-buffering" },
      { type: "text-delta", text: "hi" },
      { type: "final-answer-buffer-released" },
      { type: "tool-call", id: "call_0_0", name: "echo", args: { text: "x" } },
      { type: "tool-output-delta", id: "call_0_0", chunk: "compiling…" },
      { type: "tool-result", id: "call_0_0", ok: true, output: "x" },
      { type: "stop", reason: "model-stop" },
      { type: "stop", reason: "error", message: "boom" },
      { type: "stop", reason: "error", code: "malformed-chunk", message: "boom" },
      { type: "stop", reason: "length" },
      { type: "verification-requested", prompt: "verify your work" },
      { type: "loop-detected", signal: "tool-repeat", detail: "echo" },
      { type: "stop", reason: "loop-detected" },
      { type: "budget-warning", usedTokens: 6, maxTokens: 10 },
      {
        type: "budget-warning",
        metric: "gross",
        usedTokens: 60,
        maxTokens: 100,
      },
      { type: "infra-error", source: "tool", message: "tool 'slow' exceeded 1000ms" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 3 } },
    ];
    for (const v of variants) expect(KernelEvent.parse(v)).toEqual(v);
  });

  it("rejects unknown stop reasons, bad turn numbers, and unknown keys", () => {
    expect(StopReason.safeParse("nope").success).toBe(false);
    expect(KernelEvent.safeParse({ type: "turn-started", turn: 0 }).success).toBe(false);
    expect(KernelEvent.safeParse({ type: "turn-started", turn: 1.5 }).success).toBe(false);
    expect(KernelEvent.safeParse({ type: "run-started", extra: 1 }).success).toBe(false);
    expect(
      KernelEvent.safeParse({
        type: "tool-liveness",
        itemIndex: 1,
        id: "call_0_0",
        elapsedMs: 2_000,
      }).success,
    ).toBe(false); // presentation ticks cannot enter session/eval event carriage
    expect(
      KernelEvent.safeParse({
        type: "approval-opened",
        detail: "forged replay approval",
        sessionAvailable: true,
        information: {
          exactResource: { status: "available", kind: "domain", value: "example.com" },
        },
      }).success,
    ).toBe(false); // live approval presentation cannot enter session/eval event carriage
  });

  it("wire round-trips every variant (JSON serialize→parse identity) — events feed session/trajectory JSON", () => {
    assertWireRoundTrips(KernelEvent);
  });

  it("classifies non-error model-stop detail that still needs attention", () => {
    expect(stopCodeNeedsAttention(REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE)).toBe(true);
    expect(stopCodeNeedsAttention(BLOCKED_AFTER_SYNTHESIS_CODE)).toBe(true);
    expect(stopCodeNeedsAttention("OTHER")).toBe(false);
    expect(stopCodeNeedsAttention(undefined)).toBe(false);
  });

  it("keeps blocked-after-synthesis copy explicit that an answer was produced", () => {
    expect(BLOCKED_AFTER_SYNTHESIS_MESSAGE).toBe(
      "answered from prior evidence; blocked action was not executed",
    );
  });

  it("maps loop-level terminal records onto public stop reasons", () => {
    expect(stopReasonForLoopStopped("succeeded")).toBeUndefined();
    expect(stopReasonForLoopStopped("loop-max-iterations")).toBe("max-turns");
    expect(stopReasonForLoopStopped("loop-deadline")).toBe("deadline");
    expect(stopReasonForLoopStopped("loop-budget")).toBe("budget");
    expect(stopReasonForLoopStopped("loop-no-progress")).toBe("loop-detected");
    expect(stopReasonForLoopStopped("aborted")).toBe("aborted");
    expect(stopReasonForLoopStopped("error")).toBe("error");
  });
});
