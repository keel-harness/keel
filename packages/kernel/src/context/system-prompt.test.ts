import { describe, expect, it } from "vitest";
import {
  SYSTEM_PROMPT,
  boundedJsonStringify,
  buildSystemPrompt,
  messageTokens,
  estimateTokens,
} from "./system-prompt.js";

describe("estimateTokens (heuristic, no tokenizer dep)", () => {
  it("approximates ~4 chars/token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(401))).toBe(101);
  });
});

describe("SYSTEM_PROMPT (§7 Epic 1.6 — <2,000 tokens, 4-phase protocol, honesty)", () => {
  it("stays under the 2,000-token budget (CI gate)", () => {
    expect(estimateTokens(SYSTEM_PROMPT)).toBeLessThan(2000);
  });

  it("encodes keel's identity (governance-native, not generic)", () => {
    expect(SYSTEM_PROMPT).toMatch(/\bkeel\b/);
  });

  it("encodes the four-phase problem-solving protocol", () => {
    expect(SYSTEM_PROMPT).toMatch(/plan/i);
    expect(SYSTEM_PROMPT).toMatch(/\b(build|implement)\b/i);
    expect(SYSTEM_PROMPT).toMatch(/verify/i);
    expect(SYSTEM_PROMPT).toMatch(/\bfix\b/i);
  });

  it("verifies against the ORIGINAL task, not the model's own code (the key anti-pattern)", () => {
    expect(SYSTEM_PROMPT).toMatch(/original task|not.*your own code|not against your own/i);
  });

  it("encodes the §8.6 honesty contract: final-answer structure + no invention", () => {
    expect(SYSTEM_PROMPT).toMatch(/verif/i); // what you verified
    expect(SYSTEM_PROMPT).toMatch(/not.{0,12}verif/i); // and what you did NOT verify
    expect(SYSTEM_PROMPT).toMatch(/invent|never claim|did not|didn't/i); // no hallucinated results
  });

  it("teaches warden-result honesty: denied or reviewed actions did not execute", () => {
    expect(SYSTEM_PROMPT).toMatch(/warden/i);
    expect(SYSTEM_PROMPT).toMatch(/denied|blocked|review required/i);
    expect(SYSTEM_PROMPT).toMatch(/not executed|did not execute|blocked before execution/i);
    expect(SYSTEM_PROMPT).toMatch(/never.{0,80}ran|do not say.{0,80}ran/i);
  });

  it("preserves operator-requested exact command bytes and relies on structured exit evidence", () => {
    expect(SYSTEM_PROMPT).toMatch(/exact command/i);
    expect(SYSTEM_PROMPT).toMatch(/unchanged|byte-for-byte/i);
    expect(SYSTEM_PROMPT).toMatch(/exit (?:code|status).{0,120}(?:already|result|tool)/i);
    expect(SYSTEM_PROMPT).toMatch(/do not append.{0,100}(?:echo|status|\$\?)/i);
  });

  it("teaches the argv-only process and shell-composition division without automatic conversion", () => {
    expect(SYSTEM_PROMPT).toMatch(/process\.run.{0,160}(?:direct|one executable)/is);
    expect(SYSTEM_PROMPT).toMatch(/bash.{0,120}(?:shell composition|persistent shell state)/is);
    expect(SYSTEM_PROMPT).toMatch(
      /never.{0,80}(?:convert|translate).{0,80}(?:bash|process\.run)/is,
    );
  });

  it("keeps nonzero command failure separate from following the requested procedure", () => {
    expect(SYSTEM_PROMPT).toMatch(/non[- ]?zero exit.{0,120}(?:command|process).{0,80}fail/is);
    expect(SYSTEM_PROMPT).toMatch(/followed.{0,120}(?:request|procedure)/is);
    expect(SYSTEM_PROMPT).toMatch(
      /do not describe.{0,120}(?:command|execution|outcome).{0,120}(?:successful|partially successful)/is,
    );
    expect(SYSTEM_PROMPT).toMatch(/requested task.{0,100}(?:did not|didn't|has not) succeed/is);
    expect(SYSTEM_PROMPT).toMatch(
      /(?:may|can) say.{0,120}executed.{0,60}(?:as requested|as instructed)/is,
    );
  });

  it("does not turn a successful side-effecting bash exit into verified workspace state", () => {
    expect(SYSTEM_PROMPT).toMatch(/zero exit.{0,120}process.{0,80}not.{0,120}filesystem/is);
    expect(SYSTEM_PROMPT).toMatch(
      /side[- ]effecting bash.{0,180}(?:typed observation|subsequent read).{0,120}(?:claim|report)/is,
    );
  });

  it("does not invent an approval path for terminal review-required tool results", () => {
    expect(SYSTEM_PROMPT).toMatch(/no live approval/i);
    expect(SYSTEM_PROMPT).toMatch(/do not (?:tell|ask).{0,100}approv/i);
    expect(SYSTEM_PROMPT).toMatch(/\/reviews.{0,100}Autopilot/i);
    expect(SYSTEM_PROMPT).toMatch(/explicitly offers.{0,120}one fresh.{0,80}request/is);
    expect(SYSTEM_PROMPT).toMatch(/Warden.{0,80}reevaluates/is);
    expect(SYSTEM_PROMPT).toMatch(/otherwise.{0,80}do not retry/is);
    expect(SYSTEM_PROMPT).not.toMatch(/do not retry related commands automatically/i);
  });

  it("keeps read-only explanations narrow and stops once authoritative evidence is sufficient", () => {
    expect(SYSTEM_PROMPT).toMatch(/read.{0,20}search.{0,50}(?:prefer|over).{0,20}bash/i);
    expect(SYSTEM_PROMPT).toMatch(/authoritative.{0,80}(?:enough|sufficient).{0,80}stop/i);
    expect(SYSTEM_PROMPT).toMatch(
      /read.{0,40}(?:file-only|not a directory|does not accept directories)/i,
    );
    expect(SYSTEM_PROMPT).toMatch(/director.{0,100}search.{0,80}filename/i);
    expect(SYSTEM_PROMPT).toContain('`kind: "filename", pattern: "packages/**"`');
    expect(SYSTEM_PROMPT).not.toContain("such as `packages/*`");
  });

  it("teaches Autopilot authority: user-selected warden posture, never AGENTS.md policy", () => {
    expect(SYSTEM_PROMPT).toMatch(/Autopilot/i);
    expect(SYSTEM_PROMPT).toMatch(/Project Autopilot/i);
    expect(SYSTEM_PROMPT).toMatch(/policy posture|warden/i);
    expect(SYSTEM_PROMPT).toMatch(/user|operator|human/i);
    expect(SYSTEM_PROMPT).toMatch(/AGENTS\.md|project instructions|project files/i);
    expect(SYSTEM_PROMPT).toMatch(/cannot.{0,80}(raise autonomy|change policy|bypass)/i);
  });

  it("encodes read-before-edit and truncated-output honesty", () => {
    // "Read a file this session before you edit it." — proximity bound sized to that plain phrasing.
    expect(SYSTEM_PROMPT).toMatch(/read.{0,30}before.{0,12}edit/i);
    expect(SYSTEM_PROMPT).toMatch(/truncat/i);
  });

  it("encodes keel-unique trust discipline: care without a sandbox + steerability", () => {
    expect(SYSTEM_PROMPT).toMatch(/sandbox|reversible|irreversible|destructive/i);
    expect(SYSTEM_PROMPT).toMatch(/steer|latest instruction|constraint/i);
  });

  it("tells the agent to back up irreplaceable inputs before mutating them (recovery/repair tasks)", () => {
    // Regression for the TB-2 db-wal-recovery failure: keel destroyed the input WAL file by opening
    // the DB (an in-place-mutating op that did not look dangerous) instead of copying the originals first.
    expect(SYSTEM_PROMPT).toMatch(/back up|cp /i);
    expect(SYSTEM_PROMPT).toMatch(/irreplaceable|recover|corrupted|overwrite/i);
  });

  it("tells the agent to read thoroughly (trust-but-verify) and match existing conventions", () => {
    expect(SYSTEM_PROMPT).toMatch(/not behavior|read the real code|understand them/i); // don't skim/assume
    expect(SYSTEM_PROMPT).toMatch(/surrounding code|conventions|reuse/i); // match existing style/patterns
  });

  it("avoids response-format boilerplate (native tool calling; KIRA lesson)", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/```json|respond with json|xml|<tool_call>/i);
  });
});

describe("buildSystemPrompt — Feature B: plan-prompt hardening (KEEL_PLAN_PROMPT_V2)", () => {
  it("V2 (default): the prompt tells the model to treat the plan as durable, interruption-proof memory", () => {
    const p = buildSystemPrompt({}); // default env → V2
    expect(p).toMatch(/compacted or reset/i);
    expect(p).toMatch(/ruled out|dead ?end|decisions you (make|made)/i);
  });

  it("V1 (KEEL_PLAN_PROMPT_V2=0): the hardening clause is absent (for the A/B baseline arm)", () => {
    const p = buildSystemPrompt({ KEEL_PLAN_PROMPT_V2: "0" });
    expect(p).not.toMatch(/compacted or reset/i);
  });

  it("stays under the 2000-token budget in both arms", () => {
    expect(messageTokens({ content: buildSystemPrompt({}) })).toBeLessThan(2000);
    expect(
      messageTokens({ content: buildSystemPrompt({ KEEL_PLAN_PROMPT_V2: "0" }) }),
    ).toBeLessThan(2000);
  });

  it("counts assistant tool-call arguments as model-visible context", () => {
    const withoutArgs = messageTokens({ content: "" });
    const withArgs = messageTokens({
      content: "",
      toolCalls: [
        {
          id: "call-1",
          name: "bash",
          args: { command: `python - <<'PY'\n${"print(1)\n".repeat(500)}PY` },
        },
      ],
    });

    expect(withArgs).toBeGreaterThan(withoutArgs + 1_000);
  });

  it("conservatively overcounts non-serializable unknown tool-call args", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(() =>
      messageTokens({
        content: "x",
        toolCalls: [{ id: "call-1", name: "debug", args: circular }],
      }),
    ).not.toThrow();
    expect(
      messageTokens({
        content: "x",
        toolCalls: [{ id: "call-1", name: "debug", args: circular }],
      }),
    ).toBeGreaterThan(250_000);
  });

  it("bounds JSON stringification by depth and node count before serializing", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 64; i++) {
      deep = { child: deep };
    }

    expect(boundedJsonStringify(deep, { maxDepth: 8 })).toBeNull();
    expect(
      boundedJsonStringify(
        Array.from({ length: 20 }, (_, i) => i),
        { maxNodes: 8 },
      ),
    ).toBeNull();
  });

  it("handles hostile JSON edge cases without unbounded serialization", () => {
    const circular: unknown[] = [];
    circular.push(circular);

    expect(boundedJsonStringify(circular)).toBeNull();
    expect(
      boundedJsonStringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])), {
        maxNodes: 8,
      }),
    ).toBeNull();
    expect(boundedJsonStringify({ n: BigInt(1) })).toBeNull();
    expect(boundedJsonStringify(undefined)).toBe("");
    expect(boundedJsonStringify({ x: "\n".repeat(5) }, { maxChars: 16 })).toBeNull();
  });
});
