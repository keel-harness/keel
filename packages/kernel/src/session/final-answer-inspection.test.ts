import { describe, expect, it } from "vitest";
import type { FinalAnswerOccurrenceT, FinalAnswerSettlementT, ModelMessageT } from "@keel/shared";
import type { ResumeState } from "./resume.js";
import { latestFinalAnswerOriginal } from "./final-answer-inspection.js";

const contract = { version: 1 as const, maxWords: 40 };

function state(input: {
  readonly messages?: ModelMessageT[];
  readonly occurrences?: ReadonlyMap<number, FinalAnswerOccurrenceT>;
  readonly settlements?: ReadonlyMap<string, FinalAnswerSettlementT>;
}): ResumeState {
  return {
    messages: input.messages ?? [],
    inputHistory: [],
    failedToolCallIds: new Set(),
    failedToolMessageIndexes: new Set(),
    finalAnswerOccurrences: input.occurrences ?? new Map(),
    finalAnswerSettlements: input.settlements ?? new Map(),
    interruptedFinalAnswerSettlementIds: new Set(),
    pendingSteering: [],
    finished: true,
  };
}

describe("latestFinalAnswerOriginal", () => {
  it("selects the latest fully settled original by typed occurrence identity", () => {
    const messages: ModelMessageT[] = [
      { role: "assistant", content: "older original" },
      { role: "assistant", content: "newer original" },
    ];
    const result = latestFinalAnswerOriginal(
      state({
        messages,
        occurrences: new Map([
          [0, { settlementId: "fas_old", kind: "attempt", attempt: "original", contract }],
          [1, { settlementId: "fas_new", kind: "attempt", attempt: "original", contract }],
        ]),
        settlements: new Map([
          ["fas_old", { settlementId: "fas_old", outcome: "accepted-original" }],
          ["fas_new", { settlementId: "fas_new", outcome: "fallback-length" }],
        ]),
      }),
    );

    expect(result).toEqual({ settlementId: "fas_new", messageIndex: 1, message: messages[1] });
  });

  it("rejects absent, duplicate, rewrite-only, and non-assistant originals instead of guessing", () => {
    expect(latestFinalAnswerOriginal(state({}))).toBeUndefined();

    const settlement = new Map<string, FinalAnswerSettlementT>([
      ["fas_bad", { settlementId: "fas_bad", outcome: "accepted-original" }],
    ]);
    const duplicate = new Map<number, FinalAnswerOccurrenceT>([
      [0, { settlementId: "fas_bad", kind: "attempt", attempt: "original", contract }],
      [1, { settlementId: "fas_bad", kind: "attempt", attempt: "original", contract }],
    ]);
    expect(
      latestFinalAnswerOriginal(
        state({
          messages: [
            { role: "assistant", content: "one" },
            { role: "assistant", content: "two" },
          ],
          occurrences: duplicate,
          settlements: settlement,
        }),
      ),
    ).toBeUndefined();

    expect(
      latestFinalAnswerOriginal(
        state({
          messages: [{ role: "assistant", content: "rewrite" }],
          occurrences: new Map([
            [0, { settlementId: "fas_bad", kind: "attempt", attempt: "rewrite", contract }],
          ]),
          settlements: settlement,
        }),
      ),
    ).toBeUndefined();

    expect(
      latestFinalAnswerOriginal(
        state({
          messages: [{ role: "user", content: "not provider output" }],
          occurrences: new Map([
            [0, { settlementId: "fas_bad", kind: "attempt", attempt: "original", contract }],
          ]),
          settlements: settlement,
        }),
      ),
    ).toBeUndefined();
  });
});
