import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  R21_OVERSIZED_FINAL_ANSWER,
  R21_OVERSIZED_FINAL_ANSWER_WORDS,
} from "./fixtures/r21-oversized-final-answer.js";
import {
  buildFinalAnswerFallback,
  finalAnswerVisibleByteLimit,
  finalAnswerWordCount,
  finalAnswerRewriteOutputTokens,
  finalAnswerRewritePrompt,
  validateFinalAnswer,
} from "./final-answer.js";

describe("ADR-0087 final-answer contract primitives", () => {
  it("freezes the sanitized R21 568-word/table acceptance shape", () => {
    expect(R21_OVERSIZED_FINAL_ANSWER.match(/\S+/gu)).toHaveLength(
      R21_OVERSIZED_FINAL_ANSWER_WORDS,
    );
    expect(R21_OVERSIZED_FINAL_ANSWER).toContain("| Area | Finding |");
    expect(
      validateFinalAnswer(R21_OVERSIZED_FINAL_ANSWER, { version: 1, maxWords: 250 }),
    ).toMatchObject({ ok: false, wordCount: 568, reason: "words" });
  });

  it("derives the bounded byte rail and secondary rewrite-token rail exactly", () => {
    expect(finalAnswerVisibleByteLimit({ version: 1, maxWords: 40 })).toBe(2_560);
    expect(finalAnswerVisibleByteLimit({ version: 1, maxWords: 250 })).toBe(16_000);
    expect(finalAnswerVisibleByteLimit({ version: 1, maxWords: 2_000 })).toBe(64_000);

    expect(finalAnswerRewriteOutputTokens({ version: 1, maxWords: 40 })).toBe(256);
    expect(finalAnswerRewriteOutputTokens({ version: 1, maxWords: 250 })).toBe(1_000);
    expect(finalAnswerRewriteOutputTokens({ version: 1, maxWords: 2_000 }, 1_500)).toBe(1_500);
  });

  it.each([
    { maxWords: 40, maxBytes: 2_560, targetWords: 36 },
    { maxWords: 250, maxBytes: 16_000, targetWords: 225 },
    { maxWords: 2_000, maxBytes: 64_000, targetWords: 1_800 },
  ] as const)(
    "keeps the exact $maxWords-word hard bound while targeting $targetWords-word headroom",
    ({ maxWords, maxBytes, targetWords }) => {
      const prompt = finalAnswerRewritePrompt({ version: 1, maxWords });
      expect(prompt).toContain(
        `Hard limits: at most ${maxWords} words and at most ${maxBytes} UTF-8 bytes.`,
      );
      expect(prompt).toContain(`Aim for ${targetWords} words or fewer to leave counting headroom.`);
      expect(prompt).toContain(
        "Do not present runtime behavior as verified unless preceding tool results demonstrate it. Omit unsupported runtime specifics; if material, say only that the behavior was not probed.",
      );
      expect(targetWords).toBeGreaterThan(0);
      expect(targetWords).toBeLessThan(maxWords);
    },
  );

  it("leaves positive rewrite headroom across the complete contract range", () => {
    fc.assert(
      fc.property(fc.integer({ min: 40, max: 2_000 }), (maxWords) => {
        const prompt = finalAnswerRewritePrompt({ version: 1, maxWords });
        const match = /Aim for (\d+) words or fewer to leave counting headroom\./u.exec(prompt);
        expect(match).not.toBeNull();
        const targetWords = Number(match?.[1]);
        expect(targetWords).toBe(Math.floor(maxWords * 0.9));
        expect(targetWords).toBeGreaterThan(0);
        expect(targetWords).toBeLessThan(maxWords);
      }),
      { numRuns: 200 },
    );
  });

  it("counts non-whitespace runs after control stripping and newline normalization", () => {
    const poisoned = `one\u001b[31m two\r\nthree\u2028four\u0000\t**five**`;
    expect(finalAnswerWordCount(poisoned)).toBe(5);
    expect(validateFinalAnswer(poisoned, { version: 1, maxWords: 40 })).toMatchObject({
      ok: true,
      wordCount: 5,
    });
  });

  it("rejects a hostile no-whitespace payload on the byte rail", () => {
    const hostile = "界".repeat(900);
    expect(finalAnswerWordCount(hostile)).toBe(1);
    expect(validateFinalAnswer(hostile, { version: 1, maxWords: 40 })).toMatchObject({
      ok: false,
      wordCount: 1,
      reason: "bytes",
    });
  });

  it.each([
    "fallback-budget",
    "fallback-cancelled",
    "fallback-length",
    "fallback-error",
    "fallback-tool-call",
    "fallback-oversized",
  ] as const)("builds a truthful %s fallback within the 40-word minimum", (outcome) => {
    const fallback = buildFinalAnswerFallback({
      contract: { version: 1, maxWords: 40 },
      outcome,
      originalInspectionCommand: "keel sessions answer ses_01ARZ3NDEKTSV4RRFFQ69G5FAV --original",
      attentionFacts: ["2 failed tools", "1 Warden denial", "tests not run"],
    });
    expect(validateFinalAnswer(fallback, { version: 1, maxWords: 40 }).ok).toBe(true);
    expect(fallback).toContain("could not obtain");
    expect(fallback).toContain("No rewrite tools or side effects ran");
    expect(fallback).toContain("keel sessions answer");
  });

  it("never exceeds either rail for arbitrary text", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 40, max: 2_000 }), (text, maxWords) => {
        const contract = { version: 1 as const, maxWords };
        const result = validateFinalAnswer(text, contract);
        expect(result.wordCount).toBe(finalAnswerWordCount(text));
        if (result.ok) {
          expect(result.wordCount).toBeLessThanOrEqual(maxWords);
          expect(result.visibleBytes).toBeLessThanOrEqual(finalAnswerVisibleByteLimit(contract));
        }
      }),
      { numRuns: 300 },
    );
  });
});
