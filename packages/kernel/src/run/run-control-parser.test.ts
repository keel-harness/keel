import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { ENTROPY_NET_MIN_TOKEN_CHARS, MAX_LOOP_ITERATIONS } from "@keel/shared";
import { parseGoalArgs, parseLoopArgs, shellJoin, shellWords } from "./run-control-parser.js";
import { redactText } from "../secrets/redact.js";

describe("run-control command parsers (Epic 2.12 product surface)", () => {
  it("leaves validation unconfigured (opt-in) when --validation is absent (F-3 RC2a)", () => {
    // Default validation was `standard`, which requires a lifecycle manifest a normal workspace does
    // not have → the tier reported `not_run` → the goal was structurally `incomplete` even when every
    // check passed. Making the tier opt-in lets a plain `/goal --check` reach the honest `unverified`
    // terminal (ADR-0060) when its checks pass, instead of a confusing `incomplete`.
    const parsed = parseGoalArgs('Fix the off-by-one --check "pnpm test"');
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error);
    expect(parsed.goal.validation).toBeUndefined();
  });

  it("configures the validation tier only when --validation is passed", () => {
    const parsed = parseGoalArgs('Fix it --check "pnpm test" --validation minimal');
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error);
    expect(parsed.goal.validation).toEqual({ tier: "minimal" });
  });

  it("parses a public /goal constructor into a first-class Goal", () => {
    const parsed = parseGoalArgs(
      'Ship the run control slice --check "pnpm typecheck" --check "pnpm test" --max-turns 12 --max-wall-ms 60000 --validation strict',
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error);
    expect(parsed.goal.objective).toBe("Ship the run control slice");
    expect(parsed.goal.validation).toEqual({ tier: "strict" });
    expect(parsed.goal.bounds).toEqual({ maxTurns: 12, maxWallMs: 60_000 });
    expect(parsed.goal.doneWhen).toEqual([
      { id: "check-1", kind: "command", check: { argv: ["pnpm", "typecheck"] } },
      { id: "check-2", kind: "command", check: { argv: ["pnpm", "test"] } },
    ]);
  });

  it("parses a wrapped quoted /goal check pasted from a terminal transcript", () => {
    const parsed = parseGoalArgs(
      'Confirm the TUI tests still pass --check "pnpm vitest run\npackages/kernel/src/tui/conversation-block.test.ts --reporter=dot --maxWorkers=4"',
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error);
    expect(parsed.goal.doneWhen).toEqual([
      {
        id: "check-1",
        kind: "command",
        check: {
          argv: [
            "pnpm",
            "vitest",
            "run",
            "packages/kernel/src/tui/conversation-block.test.ts",
            "--reporter=dot",
            "--maxWorkers=4",
          ],
        },
      },
    ]);
  });

  it("fails closed for goals without explicit evidence checks", () => {
    const parsed = parseGoalArgs("Just keep going until you think it is done");

    expect(parsed).toEqual({
      success: false,
      error: "goal requires at least one --check command",
    });
  });

  it("reports malformed goal constructors without creating partial goals", () => {
    expect(parseGoalArgs('"unterminated')).toEqual({
      success: false,
      error: "unterminated quoted string",
    });
    expect(parseGoalArgs('--check "pnpm test"')).toEqual({
      success: false,
      error: "goal objective is required",
    });
    expect(parseGoalArgs("Ship --check")).toEqual({
      success: false,
      error: "--check requires a command",
    });
    expect(parseGoalArgs('Ship --check "pnpm test" --max-turns 0')).toEqual({
      success: false,
      error: "--max-turns requires a positive integer",
    });
    expect(parseGoalArgs('Ship --check "pnpm test" --validation bespoke')).toEqual({
      success: false,
      error: "--validation must be minimal, standard, or strict",
    });
    expect(parseGoalArgs('Ship --check "pnpm test" --wat')).toEqual({
      success: false,
      error: "unknown goal option: --wat",
    });
  });

  it("keeps shared goal schema authority after CLI parsing", () => {
    const parsed = parseGoalArgs('!!! --check "pnpm test" --max-turns 1001');

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected invalid goal");
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("parses a bounded /loop constructor and rejects scheduler-shaped input", () => {
    const parsed = parseLoopArgs(
      'Fix tests until green --until "pnpm test" --max-iterations 4 --max-wall-ms 60000',
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error);
    expect(parsed.loop.prompt).toBe("Fix tests until green");
    expect(parsed.loop.bounds).toEqual({ maxIterations: 4, maxWallMs: 60_000 });
    expect(parsed.loop.until).toEqual({
      kind: "command",
      check: { argv: ["pnpm", "test"] },
      satisfiedWhen: "exitZero",
    });

    expect(parseLoopArgs('Fix tests --until "pnpm test" --schedule "*/5 * * * *"')).toEqual({
      success: false,
      error: "loop does not support scheduler/background fields",
    });
  });

  it("reports malformed loop constructors without creating partial loops", () => {
    expect(parseLoopArgs('"unterminated')).toEqual({
      success: false,
      error: "unterminated quoted string",
    });
    expect(parseLoopArgs('--until "pnpm test"')).toEqual({
      success: false,
      error: "loop prompt is required",
    });
    expect(parseLoopArgs("Fix --until")).toEqual({
      success: false,
      error: "--until requires a command",
    });
    expect(parseLoopArgs('Fix --until "pnpm test" --max-iterations 0')).toEqual({
      success: false,
      error: "--max-iterations requires a positive integer",
    });
    expect(parseLoopArgs('Fix --until "pnpm test" --wat')).toEqual({
      success: false,
      error: "unknown loop option: --wat",
    });
    expect(parseLoopArgs("Fix")).toEqual({
      success: false,
      error: "loop requires --until command",
    });
  });

  it("keeps shared loop schema authority after CLI parsing", () => {
    const parsed = parseLoopArgs('Fix --until "pnpm test" --max-iterations 1001');

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected invalid loop");
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("round-trips shell words for explicit argv evidence without executing a shell", () => {
    const argv = ["pnpm", "test", "--", "path with space.test.ts"];
    expect(shellWords(shellJoin(argv))).toEqual(argv);
    expect(shellWords("cmd trailing\\")).toEqual(["cmd", "trailing\\"]);
  });
});

describe("generated run-control ids stay below the SEC-014 entropy-net floor", () => {
  // A generated id (and every composite derived from it — the loop exit-check tool-call id
  // `<id>_exit_<n>`, evidence refs) is written to the session ledger as a VALUE, so it passes
  // through the SEC-014 entropy net. The net's false-positive guard assumes benign ids never
  // reach 44 chars; an id that does is redacted to `[redacted:high-entropy]`, which bricks the
  // ledger (goal_started's RunControlId regex rejects the marker → SessionCorruptError on read).
  it("a long /goal objective yields an id the redaction filter passes through unchanged", () => {
    const parsed = parseGoalArgs(
      'fix the flaky warden handshake timeout under load --check "pnpm test"',
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error);
    expect(redactText(parsed.goal.id)).toBe(parsed.goal.id);
  });

  it("the worst-case derived composite (loop exit-check tool-call id at max iterations) survives redaction", () => {
    const parsed = parseLoopArgs(
      'keep the build green until the whole suite passes --until "pnpm test" --max-iterations 1000',
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error);
    const composite = `${parsed.loop.id}_exit_${String(MAX_LOOP_ITERATIONS)}`;
    expect(redactText(composite)).toBe(composite);
  });

  it("a slug cut landing on a dash still yields a schema-valid id (trailing-dash trim)", () => {
    // Mutation gap found in QC: without the post-cut trim, a slug whose 20-char cap lands on a
    // word boundary leaves `goal_…-_<hash>`, which RunControlId rejects — surfacing to the user
    // as a /goal parse failure. Sweep the cut across the boundary so at least one position lands
    // exactly on the dash regardless of how the cap constant moves.
    for (let firstWord = 14; firstWord <= 25; firstWord++) {
      const objective = `${"a".repeat(firstWord)} ${"b".repeat(30)}`;
      const parsed = parseGoalArgs(`${objective} --check "pnpm test"`);
      expect(parsed.success, `objective with ${String(firstWord)}-char first word`).toBe(true);
      if (parsed.success) expect(redactText(parsed.goal.id)).toBe(parsed.goal.id);
    }
  });

  it("the id budget keeps explicit headroom below the entropy-net floor at the loop schema's max iterations", () => {
    // stableId's budget reserves the `_exit_<MAX_LOOP_ITERATIONS>` suffix; both the schema's
    // `.max()` and the parser's reserve now derive from the same shared constant, and this test
    // derives the worst composite from it too — so raising the iteration bound (or the slug cap)
    // shows up here as a red test, not silently in a ledger.
    const parsed = parseLoopArgs(
      `${"antidisestablishmentarianism".repeat(4)} --until "pnpm test" --max-iterations 1000`,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error);
    const composite = `${parsed.loop.id}_exit_${String(MAX_LOOP_ITERATIONS)}`;
    expect(composite.length).toBeLessThan(ENTROPY_NET_MIN_TOKEN_CHARS);
    expect(redactText(composite)).toBe(composite);
  });

  it("property: goal and loop ids and their exit-check composites are fixed points of redactText", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 120 }),
          fc.fullUnicodeString({ minLength: 1, maxLength: 120 }),
        ),
        (raw) => {
          // Quotes/backslashes only affect shell tokenization, not id generation — normalize them
          // so the property exercises the id path, not the tokenizer's error paths.
          const label = raw.replace(/["'\\]/gu, "x").trim();
          fc.pre(label.length > 0);

          const goal = parseGoalArgs(`${label} --check "pnpm test"`);
          if (goal.success) {
            expect(redactText(goal.goal.id)).toBe(goal.goal.id);
            const composite = `${goal.goal.id}_exit_${String(MAX_LOOP_ITERATIONS)}`;
            expect(redactText(composite)).toBe(composite);
          }

          const loop = parseLoopArgs(`${label} --until "pnpm test"`);
          if (loop.success) {
            expect(redactText(loop.loop.id)).toBe(loop.loop.id);
            const composite = `${loop.loop.id}_exit_${String(MAX_LOOP_ITERATIONS)}`;
            expect(redactText(composite)).toBe(composite);
          }

          // Labels that parse as neither (flag-shaped words, etc.) are tokenizer concerns, not
          // id-generation cases; require at least the goal OR loop path to have produced an id.
          fc.pre(goal.success || loop.success);
        },
      ),
    );
  });
});
