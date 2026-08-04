import type { FinalAnswerContractT, FinalAnswerSettlementT } from "@keel/shared";
import { oneLineText, stripControl } from "./control-strip.js";

export type FinalAnswerFallbackOutcome = Exclude<
  FinalAnswerSettlementT["outcome"],
  "accepted-original" | "accepted-rewrite"
>;

export interface FinalAnswerValidation {
  readonly ok: boolean;
  readonly normalized: string;
  readonly wordCount: number;
  readonly visibleBytes: number;
  readonly reason?: "words" | "bytes";
}

/** Normalize only presentation-hostile control/newline forms. Markdown punctuation remains data. */
export function normalizeFinalAnswerText(value: string): string {
  return stripControl(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u2028\u2029]/gu, "\n");
}

/** ADR-0087 v1: one word is one non-whitespace run after deterministic normalization. */
export function finalAnswerWordCount(value: string): number {
  return normalizeFinalAnswerText(value).match(/\S+/gu)?.length ?? 0;
}

export function finalAnswerVisibleByteLimit(contract: FinalAnswerContractT): number {
  return Math.min(64_000, Math.max(2_560, contract.maxWords * 64));
}

export function validateFinalAnswer(
  value: string,
  contract: FinalAnswerContractT,
): FinalAnswerValidation {
  const normalized = normalizeFinalAnswerText(value);
  const wordCount = normalized.match(/\S+/gu)?.length ?? 0;
  const visibleBytes = Buffer.byteLength(normalized, "utf8");
  if (wordCount > contract.maxWords) {
    return { ok: false, normalized, wordCount, visibleBytes, reason: "words" };
  }
  if (visibleBytes > finalAnswerVisibleByteLimit(contract)) {
    return { ok: false, normalized, wordCount, visibleBytes, reason: "bytes" };
  }
  return { ok: true, normalized, wordCount, visibleBytes };
}

/** Provider max-output tokens are a secondary spend rail on the tools-disabled rewrite only. */
export function finalAnswerRewriteOutputTokens(
  contract: FinalAnswerContractT,
  existingPerResponseCap?: number,
): number {
  const derived = Math.max(256, contract.maxWords * 4);
  return existingPerResponseCap === undefined ? derived : Math.min(existingPerResponseCap, derived);
}

export function finalAnswerRewritePrompt(contract: FinalAnswerContractT): string {
  return [
    "Rewrite the immediately preceding assistant answer as one complete final answer.",
    `Use at most ${contract.maxWords} words and at most ${finalAnswerVisibleByteLimit(contract)} UTF-8 bytes.`,
    "Preserve uncertainty, failed or partial results, denials, unverified work, and residual risk.",
    "Do not claim new evidence. No tools are available. Return only the rewritten final answer.",
  ].join(" ");
}

const FALLBACK_REASON: Record<FinalAnswerFallbackOutcome, string> = {
  "fallback-budget": "insufficient budget",
  "fallback-cancelled": "cancelled",
  "fallback-length": "provider length",
  "fallback-error": "provider error",
  "fallback-tool-call": "provider emitted a tool call",
  "fallback-oversized": "rewrite remained oversized",
};

export function buildFinalAnswerFallback(input: {
  readonly contract: FinalAnswerContractT;
  readonly outcome: FinalAnswerFallbackOutcome;
  readonly originalInspectionCommand: string;
  readonly attentionFacts?: readonly string[];
}): string {
  const command = oneLineText(input.originalInspectionCommand);
  const mandatory =
    "Keel could not obtain a complete final answer within the requested bound. " +
    `Reason: ${FALLBACK_REASON[input.outcome]}. ` +
    "No rewrite tools or side effects ran. " +
    `Inspect the redacted original: \`${command}\`.`;
  let output = mandatory;
  for (const rawFact of input.attentionFacts ?? []) {
    const fact = oneLineText(rawFact);
    if (fact.length === 0) continue;
    const candidate = `${output} Attention: ${fact}.`;
    if (!validateFinalAnswer(candidate, input.contract).ok) break;
    output = candidate;
  }
  // The schema's 40-word minimum reserves enough space for every mandatory outcome + maximum
  // session id. Keep this invariant executable instead of truncating the inspection command.
  if (!validateFinalAnswer(output, input.contract).ok) {
    throw new RangeError("final-answer fallback cannot fit the validated contract");
  }
  return output;
}
