import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import type { ToolInvocationT } from "@keel/shared";
import {
  callSuggestsArtifactWrite,
  createTerminalReviewRecoveryState,
  extractLoopFailureEvidence,
  extractStrongSuccessEvidence,
  recordTerminalReviewCorrectionSuccess,
  recordTerminalReviewToolResult,
  renderLoopRecoveryGuidance,
  takeTerminalReviewRecoveryCredit,
} from "./loop-recovery.js";

const bashCall = (command: string): ToolInvocationT => ({
  id: "call-test",
  name: "bash",
  args: { command },
});

describe("loop recovery helpers", () => {
  it.each(["edit", "write"] as const)(
    "earns one final terminal-review credit only after a successful ordinary typed %s",
    (toolName) => {
      const initial = createTerminalReviewRecoveryState();
      const first = takeTerminalReviewRecoveryCredit(initial);
      if (first === undefined) throw new Error("expected initial recovery credit");
      expect(first.credit).toBe("initial");
      const afterCorrection = recordTerminalReviewCorrectionSuccess(first.state);
      const afterProgress = recordTerminalReviewToolResult(afterCorrection, {
        toolName,
        ok: true,
        soleCall: true,
        boundedCorrectionTurn: false,
      });
      const final = takeTerminalReviewRecoveryCredit(afterProgress);
      if (final === undefined) throw new Error("expected progress-earned final credit");

      expect(final).toMatchObject({
        credit: "earned-final",
        state: {
          correctionAttempts: 2,
          refreshEarned: false,
          refreshConsumed: true,
          eligibleProgressSeen: true,
        },
      });
      expect(takeTerminalReviewRecoveryCredit(final.state)).toBeUndefined();
    },
  );

  it.each([
    ["read", true, true, false],
    ["search", true, true, false],
    ["bash", true, true, false],
    ["mcp.example", true, true, false],
    ["interactive_console.send_keys", true, true, false],
    ["edit", false, true, false],
    ["write", false, true, false],
    ["edit", true, false, false],
    ["write", true, false, false],
    ["edit", true, true, true],
    ["write", true, true, true],
  ] as const)(
    "does not earn a refresh for tool=%s ok=%s sole=%s correction=%s",
    (toolName, ok, soleCall, boundedCorrectionTurn) => {
      const first = takeTerminalReviewRecoveryCredit(createTerminalReviewRecoveryState());
      if (first === undefined) throw new Error("expected initial recovery credit");
      const afterCorrection = recordTerminalReviewCorrectionSuccess(first.state);
      const afterResult = recordTerminalReviewToolResult(afterCorrection, {
        toolName,
        ok,
        soleCall,
        boundedCorrectionTurn,
      });

      expect(afterResult.refreshEarned).toBe(false);
      expect(takeTerminalReviewRecoveryCredit(afterResult)).toBeUndefined();
    },
  );

  it("does not pre-earn a refresh from a typed mutation before the first correction succeeds", () => {
    const beforeReview = recordTerminalReviewToolResult(createTerminalReviewRecoveryState(), {
      toolName: "edit",
      ok: true,
      soleCall: true,
      boundedCorrectionTurn: false,
    });
    const first = takeTerminalReviewRecoveryCredit(beforeReview);
    if (first === undefined) throw new Error("expected initial recovery credit");
    const afterCorrection = recordTerminalReviewCorrectionSuccess(first.state);

    expect(afterCorrection.eligibleProgressSeen).toBe(false);
    expect(takeTerminalReviewRecoveryCredit(afterCorrection)).toBeUndefined();
  });

  it("property-bounds arbitrary recovery traces to two corrections and one refresh", () => {
    const event = fc.oneof(
      fc.constant({ kind: "review" as const }),
      fc.constant({ kind: "correction-success" as const }),
      fc.record({
        kind: fc.constant("tool-result" as const),
        toolName: fc.constantFrom(
          "edit",
          "write",
          "read",
          "search",
          "bash",
          "mcp.example",
          "interactive_console.send_keys",
        ),
        ok: fc.boolean(),
        soleCall: fc.boolean(),
        boundedCorrectionTurn: fc.boolean(),
      }),
    );

    fc.assert(
      fc.property(fc.array(event, { maxLength: 80 }), (events) => {
        let state = createTerminalReviewRecoveryState();
        let earnedFinalCredits = 0;
        for (const item of events) {
          if (item.kind === "review") {
            const taken = takeTerminalReviewRecoveryCredit(state);
            if (taken !== undefined) {
              if (taken.credit === "earned-final") earnedFinalCredits += 1;
              state = taken.state;
            }
          } else if (item.kind === "correction-success") {
            state = recordTerminalReviewCorrectionSuccess(state);
          } else {
            state = recordTerminalReviewToolResult(state, item);
          }

          expect(state.correctionAttempts).toBeLessThanOrEqual(2);
          expect(earnedFinalCredits).toBeLessThanOrEqual(1);
          expect(state.refreshEarned && state.refreshConsumed).toBe(false);
          if (state.refreshConsumed) expect(state.correctionAttempts).toBe(2);
        }
      }),
    );
  });

  it("extracts a bounded redacted traceback excerpt for loop redirects", () => {
    const output = [
      "setup",
      "Traceback (most recent call last):",
      '  File "/app/train.py", line 12, in <module>',
      "    print(model.model.hidden_size)",
      "AttributeError: 'Net' object has no attribute 'model'",
      "SECRET_TOKEN=sk-test-abcdefghijklmnopqrstuvwxyz123456",
      "tail",
      "x".repeat(4000),
    ].join("\n");

    const evidence = extractLoopFailureEvidence({ ok: true, output });

    if (evidence === undefined) throw new Error("expected traceback evidence");
    expect(evidence).toContain("Traceback");
    expect(evidence).toContain("AttributeError");
    expect(evidence).not.toContain("sk-test-abcdefghijklmnopqrstuvwxyz123456");
    expect(evidence.length).toBeLessThanOrEqual(1600);
  });

  it("uses failed tool output as evidence even without a traceback keyword", () => {
    expect(
      extractLoopFailureEvidence({ ok: false, output: "command exited 1\nmissing file" }),
    ).toBe("command exited 1\nmissing file");
  });

  it("does not treat echoed success text from read-only bash as strong completion evidence", () => {
    expect(
      extractStrongSuccessEvidence(bashCall("echo 'TEST SUMMARY (pytest): PASS - 5 passed'"), {
        ok: true,
        output: "TEST SUMMARY (pytest): PASS - 5 passed",
      }),
    ).toBeUndefined();
  });

  it("does not treat fabricated success text from inline execution as strong completion evidence", () => {
    expect(
      extractStrongSuccessEvidence(
        bashCall("python -c \"print('TEST SUMMARY (pytest): PASS - 5 passed')\""),
        { ok: true, output: "TEST SUMMARY (pytest): PASS - 5 passed" },
      ),
    ).toBeUndefined();
  });

  it("does not treat compound commands with forged pass text as strong completion evidence", () => {
    expect(
      extractStrongSuccessEvidence(bashCall("pytest -q; echo '===== 8 passed in 0.42s ====='"), {
        ok: true,
        output: "===== 8 passed in 0.42s =====",
      }),
    ).toBeUndefined();
  });

  it("does not treat non-executing typed tool output as strong completion evidence", () => {
    expect(
      extractStrongSuccessEvidence(
        { id: "call-read", name: "read", args: { path: "test.log" } },
        { ok: true, output: "TEST SUMMARY (pytest): PASS - 5 passed" },
      ),
    ).toBeUndefined();
  });

  it("requires a successful tool result and a failure-free pytest summary", () => {
    expect(
      extractStrongSuccessEvidence(bashCall("pytest -q"), {
        ok: false,
        output: "===== 8 passed in 0.42s =====",
      }),
    ).toBeUndefined();

    expect(
      extractStrongSuccessEvidence(bashCall("pytest -q"), {
        ok: true,
        output: "===== 1 failed, 8 passed in 0.42s =====",
      }),
    ).toBeUndefined();

    expect(
      extractStrongSuccessEvidence(bashCall("pytest -q"), {
        ok: true,
        output: "===== 8 passed in 0.42s =====\nFAILED tests/test_api.py::test_contract",
      }),
    ).toBeUndefined();
  });

  it("recognizes strict strong success evidence from real execution", () => {
    expect(
      extractStrongSuccessEvidence(bashCall("pytest -q"), {
        ok: true,
        output: "........\n===== 8 passed in 0.42s =====",
      }),
    ).toContain("8 passed");
  });

  it("does not treat task-shaped scalar metric text as generic completion evidence", () => {
    expect(
      extractStrongSuccessEvidence(bashCall("python simulate.py"), {
        ok: true,
        output: "Final state difference: 0.0000",
      }),
    ).toBeUndefined();
  });

  it("keeps finalization guidance conditional on artifact-write evidence", () => {
    expect(
      callSuggestsArtifactWrite({
        id: "call-write",
        name: "bash",
        args: { command: "cat <<'EOF' > answer.txt\n42\nEOF" },
      }),
    ).toBe(true);
    expect(callSuggestsArtifactWrite(bashCall("pytest -q"))).toBe(false);

    const guidance = renderLoopRecoveryGuidance({
      baseGuidance: "base",
      hasArtifactWrite: false,
    });
    expect(guidance).toContain("If the task requires an output artifact");
  });
});
