import { describe, expect, it } from "vitest";
import type { FinalAnswerContractT } from "@keel/shared";
import type { KernelEventT } from "../events.js";
import {
  createFinalAnswerPresentation,
  FINAL_ANSWER_REWRITE_NOTICE,
} from "./final-answer-presentation.js";
import { finalAnswerWordCount, validateFinalAnswer } from "../final-answer.js";

const CONTRACT: FinalAnswerContractT = { version: 1, maxWords: 40 };
const COMMAND = "keel sessions answer ses_01ARZ3NDEKTSV4RRFFQ69G5FAV --original";
const usage = { inputTokens: 3, outputTokens: 5 };

function project(events: readonly KernelEventT[]) {
  const presentation = createFinalAnswerPresentation({
    contract: CONTRACT,
    originalInspectionCommand: COMMAND,
  });
  return {
    events: events.flatMap((event) => presentation.project(event)),
    retainedVisibleBytes: presentation.retainedVisibleBytes(),
  };
}

describe("ADR-0087 final-answer presentation", () => {
  it("passes through text-free controller liveness while candidate bytes are held", () => {
    const presentation = createFinalAnswerPresentation({
      contract: { version: 1, maxWords: 40 },
      originalInspectionCommand: "keel sessions answer ses_test --original",
    });
    presentation.project({ type: "turn-started", turn: 1 });
    expect(presentation.project({ type: "final-answer-buffering" })).toEqual([
      { type: "final-answer-buffering" },
    ]);
    expect(presentation.project({ type: "text-delta", text: "hidden" })).toEqual([]);
  });

  it("renders one compliant original exactly once", () => {
    const settlementId = "fas_original";
    const result = project([
      { type: "turn-started", turn: 1 },
      { type: "text-delta", text: "A bounded answer." },
      {
        type: "final-answer-attempt",
        settlementId,
        attempt: "original",
        contract: CONTRACT,
        decision: "accepted",
        usage,
      },
      { type: "final-answer-settled", settlement: { settlementId, outcome: "accepted-original" } },
    ]);

    expect(result.events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", text: "A bounded answer." },
    ]);
  });

  it("hides the oversized original, announces the one tools-off rewrite, and renders only the rewrite", () => {
    const settlementId = "fas_rewrite";
    const result = project([
      { type: "turn-started", turn: 1 },
      { type: "text-delta", text: "raw original ".repeat(100) },
      {
        type: "final-answer-attempt",
        settlementId,
        attempt: "original",
        contract: CONTRACT,
        decision: "rewrite",
        usage,
      },
      {
        type: "final-answer-rewrite-requested",
        settlementId,
        contract: CONTRACT,
        prompt: "rewrite",
      },
      { type: "text-delta", text: "One bounded rewrite." },
      {
        type: "final-answer-attempt",
        settlementId,
        attempt: "rewrite",
        contract: CONTRACT,
        decision: "accepted",
        usage,
      },
      {
        type: "final-answer-settled",
        settlement: { settlementId, outcome: "accepted-rewrite", rewriteUsage: usage },
      },
    ]);

    expect(result.events).toContainEqual({
      type: "system-notice",
      content: FINAL_ANSWER_REWRITE_NOTICE,
    });
    expect(result.events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", text: "One bounded rewrite." },
    ]);
    expect(JSON.stringify(result.events)).not.toContain("raw original");
  });

  it("renders an honest bounded fallback and retains no more than the byte rail plus one", () => {
    const settlementId = "fas_fallback";
    const huge = `\u001b[31m${"🙂".repeat(20_000)}\u001b[0m`;
    const presentation = createFinalAnswerPresentation({
      contract: CONTRACT,
      originalInspectionCommand: COMMAND,
    });
    const events: KernelEventT[] = [
      { type: "turn-started", turn: 1 },
      { type: "text-delta", text: huge },
      {
        type: "final-answer-attempt",
        settlementId,
        attempt: "original",
        contract: CONTRACT,
        decision: "fallback",
        usage,
      },
      {
        type: "final-answer-settled",
        settlement: { settlementId, outcome: "fallback-budget" },
      },
    ];
    const output = events.flatMap((event) => presentation.project(event));
    const primary = output.find((event) => event.type === "text-delta");

    expect(presentation.retainedVisibleBytes()).toBeLessThanOrEqual(2_561);
    expect(primary?.type === "text-delta" ? primary.text : "").toContain("insufficient budget");
    expect(primary?.type === "text-delta" ? primary.text : "").toContain(COMMAND);
    expect(
      finalAnswerWordCount(primary?.type === "text-delta" ? primary.text : ""),
    ).toBeLessThanOrEqual(40);
    expect(
      validateFinalAnswer(primary?.type === "text-delta" ? primary.text : "", CONTRACT).ok,
    ).toBe(true);
  });

  it("flushes ordinary working narration before its tool call when the controller releases it", () => {
    const result = project([
      { type: "turn-started", turn: 1 },
      { type: "final-answer-buffer-released" },
      { type: "text-delta", text: "Working narration." },
      { type: "tool-call", id: "read-1", name: "read", args: { path: "README.md" } },
    ]);

    expect(result.events.map((event) => event.type)).toEqual([
      "turn-started",
      "text-delta",
      "tool-call",
    ]);
    expect(result.events[1]).toEqual({ type: "text-delta", text: "Working narration." });
  });

  it("fails visible when rewrite or settlement identity does not match", () => {
    const presentation = createFinalAnswerPresentation({
      contract: CONTRACT,
      originalInspectionCommand: COMMAND,
    });
    presentation.project({ type: "turn-started", turn: 1 });
    presentation.project({ type: "text-delta", text: "raw candidate" });
    presentation.project({
      type: "final-answer-attempt",
      settlementId: "fas_expected",
      attempt: "original",
      contract: CONTRACT,
      decision: "rewrite",
      usage,
    });

    const mismatchedRewrite = presentation.project({
      type: "final-answer-rewrite-requested",
      settlementId: "fas_wrong",
      contract: CONTRACT,
      prompt: "rewrite",
    });
    expect(mismatchedRewrite[0]).toMatchObject({ type: "system-notice" });
    expect(
      mismatchedRewrite[0]?.type === "system-notice" ? mismatchedRewrite[0].content : "",
    ).toContain("did not match");
    expect(mismatchedRewrite[1]).toEqual({ type: "text-delta", text: "raw candidate" });

    expect(
      project([
        { type: "turn-started", turn: 1 },
        { type: "text-delta", text: "raw" },
        {
          type: "final-answer-attempt",
          settlementId: "fas_expected",
          attempt: "original",
          contract: CONTRACT,
          decision: "accepted",
          usage,
        },
        {
          type: "final-answer-attempt",
          settlementId: "fas_wrong",
          attempt: "rewrite",
          contract: CONTRACT,
          decision: "accepted",
          usage,
        },
      ]).events,
    ).toContainEqual(expect.objectContaining({ type: "system-notice" }));

    const emptyMismatch = createFinalAnswerPresentation({
      contract: CONTRACT,
      originalInspectionCommand: COMMAND,
    });
    emptyMismatch.project({ type: "turn-started", turn: 1 });
    expect(
      emptyMismatch.project({
        type: "final-answer-settled",
        settlement: { settlementId: "fas_missing", outcome: "accepted-original" },
      }),
    ).toEqual([expect.objectContaining({ type: "system-notice" })]);

    expect(
      project([
        { type: "turn-started", turn: 1 },
        { type: "text-delta", text: "raw" },
        {
          type: "final-answer-attempt",
          settlementId: "fas_expected",
          attempt: "original",
          contract: CONTRACT,
          decision: "accepted",
          usage,
        },
        {
          type: "final-answer-settled",
          settlement: { settlementId: "fas_wrong", outcome: "accepted-original" },
        },
      ]).events,
    ).toContainEqual(expect.objectContaining({ type: "system-notice" }));
  });

  it("bounds split multibyte input, ignores bytes beyond the rail, and appends fitting attention", () => {
    const presentation = createFinalAnswerPresentation({
      contract: CONTRACT,
      originalInspectionCommand: COMMAND,
      attentionFacts: () => ["tests remain red"],
    });
    const settlementId = "fas_attention";
    const output = [
      { type: "turn-started", turn: 1 } as const,
      { type: "text-delta", text: "" } as const,
      { type: "text-delta", text: "🙂".repeat(2_000) } as const,
      { type: "text-delta", text: "ignored after byte rail" } as const,
      { type: "text-delta", text: "fully ignored" } as const,
      {
        type: "final-answer-attempt",
        settlementId,
        attempt: "original",
        contract: CONTRACT,
        decision: "fallback",
        usage,
      } as const,
      {
        type: "final-answer-settled",
        settlement: { settlementId, outcome: "fallback-budget" },
      } as const,
    ].flatMap((event) => presentation.project(event));

    expect(presentation.retainedVisibleBytes()).toBe(2_561);
    const primary = output.find((event) => event.type === "text-delta");
    expect(primary?.type === "text-delta" ? primary.text : "").toContain(
      "Attention: tests remain red",
    );
  });
});
