import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  parseTestOutput,
  summarizeTestOutput,
  summarizeTestOutputForPresentation,
} from "./test-summary.js";

describe("summarizeTestOutput — pytest (Epic 1.12 slice 1)", () => {
  it("summarizes a failing pytest run with the failing test ids", () => {
    const out = [
      "tests/test_auth.py::test_login PASSED",
      "tests/test_auth.py::test_refresh FAILED",
      "=================================== FAILURES ===================================",
      "FAILED tests/test_auth.py::test_refresh - AssertionError: token not revoked",
      "FAILED tests/test_auth.py::test_logout - KeyError: 'sid'",
      "===================== 2 failed, 114 passed in 3.21s ======================",
    ].join("\n");
    const s = summarizeTestOutput(out, 1);
    expect(s).toBe(
      "TEST SUMMARY (pytest): FAIL — 114 passed, 2 failed; failing: tests/test_auth.py::test_refresh, tests/test_auth.py::test_logout",
    );
  });

  it("summarizes an all-passing pytest run", () => {
    const s = summarizeTestOutput("============== 5 passed in 0.42s ==============", 0);
    expect(s).toBe("TEST SUMMARY (pytest): PASS — 5 passed");
  });

  it("treats pytest errors as a failure", () => {
    const s = summarizeTestOutput("=========== 1 error in 0.10s ============", 2);
    expect(s).toBe("TEST SUMMARY (pytest): FAIL — 1 error");
  });

  it("caps the failing list at 5 and notes the remainder", () => {
    const fails = Array.from({ length: 8 }, (_v, i) => `FAILED tests/t.py::test_${String(i)}`).join(
      "\n",
    );
    const out = `${fails}\n===== 8 failed, 1 passed in 1.0s =====`;
    const s = summarizeTestOutput(out, 1);
    expect(s).toContain(
      "failing: tests/t.py::test_0, tests/t.py::test_1, tests/t.py::test_2, tests/t.py::test_3, tests/t.py::test_4 (+3 more)",
    );
  });
});

describe("summarizeTestOutputForPresentation — pytest quiet terminal summary", () => {
  it("retains every exact count from the observed Click pytest -q result", () => {
    const output = [
      "............................................................ [ 50%]",
      "............................................................ [100%]",
      "1901 passed, 24 skipped, 31000 deselected, 1 xfailed in 2.75s",
    ].join("\n");

    expect(summarizeTestOutputForPresentation(output, 0)).toBe(
      "TEST SUMMARY (pytest): PASS — 1901 passed, 24 skipped, 31000 deselected, 1 xfailed",
    );
  });

  it("retains producer order and every supported outcome category on failure", () => {
    const output =
      "2 failed, 7 passed, 3 skipped, 4 deselected, 5 xfailed, 6 xpassed, 1 warning, 8 errors in 61.00s (0:01:01)";

    expect(summarizeTestOutputForPresentation(output, 1)).toBe(
      "TEST SUMMARY (pytest): FAIL — 2 failed, 7 passed, 3 skipped, 4 deselected, 5 xfailed, 6 xpassed, 1 warning, 8 errors",
    );
  });

  it("keeps the model-facing summarizer unchanged for quiet pytest output", () => {
    const output = "1901 passed, 24 skipped, 31000 deselected, 1 xfailed in 2.75s";

    expect(summarizeTestOutput(output, 0)).toBeUndefined();
    expect(summarizeTestOutputForPresentation(output, 0)).toContain("1901 passed");
  });

  it.each([
    ["prose", "The final result was 5 passed in 0.42s."],
    ["missing duration", "5 passed, 1 skipped"],
    ["malformed separator", "5 passed,1 skipped in 0.42s"],
    ["duplicate category", "5 passed, 2 passed in 0.42s"],
    ["unknown category", "5 passed, 1 rerun in 0.42s"],
    ["no tests", "no tests ran in 0.42s"],
    ["zero-only", "0 passed in 0.42s"],
    ["leading-zero count", "001 passed in 0.42s"],
    ["unsafe integer", "9007199254740992 passed in 0.42s"],
    ["control sequence", "\u001b[32m5 passed in 0.42s\u001b[0m"],
  ])("rejects %s instead of fabricating a quiet pytest summary", (_label, output) => {
    expect(summarizeTestOutputForPresentation(output, 0)).toBeUndefined();
  });

  it("retains the existing banner recognizer as a presentation fallback", () => {
    expect(
      summarizeTestOutputForPresentation("============== 5 passed in 0.42s ==============", 0),
    ).toBe("TEST SUMMARY (pytest): PASS — 5 passed");
  });

  it("preserves generated unique pytest count lists without inventing or reordering parts", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            kind: fc.constantFrom(
              "failed",
              "passed",
              "skipped",
              "deselected",
              "xfailed",
              "xpassed",
              "warnings",
              "errors",
            ),
            count: fc.integer({ min: 1, max: 100_000 }),
          }),
          { minLength: 1, maxLength: 8, selector: (part) => part.kind },
        ),
        fc.constantFrom(0, 1),
        (parts, exitCode) => {
          const raw = parts.map(({ kind, count }) => {
            if (kind === "warnings") return `${String(count)} warning${count === 1 ? "" : "s"}`;
            if (kind === "errors") return `${String(count)} error${count === 1 ? "" : "s"}`;
            return `${String(count)} ${kind}`;
          });
          const failed =
            exitCode !== 0 ||
            parts.some(({ kind, count }) => (kind === "failed" || kind === "errors") && count > 0);
          expect(summarizeTestOutputForPresentation(`${raw.join(", ")} in 12.34s`, exitCode)).toBe(
            `TEST SUMMARY (pytest): ${failed ? "FAIL" : "PASS"} — ${raw.join(", ")}`,
          );
        },
      ),
    );
  });
});

describe("summarizeTestOutput — jest/vitest, cargo, go", () => {
  it("parses a jest summary line", () => {
    const s = summarizeTestOutput("Tests:       2 failed, 10 passed, 12 total", 1);
    expect(s).toBe("TEST SUMMARY (jest/vitest): FAIL — 10 passed, 2 failed");
  });

  it("parses a vitest summary line (different separators)", () => {
    const s = summarizeTestOutput("Tests  2 failed | 10 passed (12)", 1);
    expect(s).toBe("TEST SUMMARY (jest/vitest): FAIL — 10 passed, 2 failed");
  });

  it("ignores the vitest 'Test Files' line (only the per-test 'Tests' line counts)", () => {
    const out = "Test Files  1 failed | 2 passed (3)\nTests  3 failed | 20 passed (23)";
    expect(summarizeTestOutput(out, 1)).toBe(
      "TEST SUMMARY (jest/vitest): FAIL — 20 passed, 3 failed",
    );
  });

  it("parses a cargo test result (ok and FAILED)", () => {
    expect(summarizeTestOutput("test result: ok. 5 passed; 0 failed; 0 ignored", 0)).toBe(
      "TEST SUMMARY (cargo): PASS — 5 passed, 0 failed",
    );
    expect(summarizeTestOutput("test result: FAILED. 3 passed; 2 failed; 0 ignored", 1)).toBe(
      "TEST SUMMARY (cargo): FAIL — 3 passed, 2 failed",
    );
  });

  it("SUMS cargo unit + doctest result lines (QC: doctest must not mask unit failures)", () => {
    const out = [
      "test result: FAILED. 3 passed; 2 failed; 0 ignored",
      "test result: ok. 1 passed; 0 failed; 0 ignored", // doctests
    ].join("\n");
    expect(summarizeTestOutput(out, 101)).toBe("TEST SUMMARY (cargo): FAIL — 4 passed, 2 failed");
  });

  it("does NOT treat a prose line starting with 'Tests' as a result (QC false-positive fix)", () => {
    expect(summarizeTestOutput("Tests: the suite, 5 passed inspection", 0)).toBeUndefined();
  });

  it("parses go -v --- FAIL lines (names + count; passed unknown without -v counts)", () => {
    const out = "--- FAIL: TestFoo (0.00s)\n--- FAIL: TestBar (0.01s)\nFAIL\nexit status 1";
    expect(summarizeTestOutput(out, 1)).toBe(
      "TEST SUMMARY (go): FAIL — 2 failed; failing: TestFoo, TestBar",
    );
  });

  // Pre-existing branch-coverage gap in test-summary.ts (main was red on it; OUTSIDE
  // the cost/context workstream's scope) — closed here with additive, behavior-neutral tests so CI is
  // green. Covers parseGo's all-PASS arms and the exit-code-driven FAIL on otherwise-clean counts.
  it("go: only --- PASS lines → passed, no failed (the all-pass arm)", () => {
    const out = "--- PASS: TestA (0.00s)\n--- PASS: TestB (0.00s)\nPASS\nok\tpkg\t0.1s";
    expect(summarizeTestOutput(out, 0)).toBe("TEST SUMMARY (go): PASS — 2 passed");
  });

  it("exit code drives FAIL even when the parsed counts are clean (a non-test failure after passing)", () => {
    expect(summarizeTestOutput("============== 5 passed in 0.42s ==============", 1)).toBe(
      "TEST SUMMARY (pytest): FAIL — 5 passed",
    );
  });
});

describe("summarizeTestOutput — honest fallback + no fabrication", () => {
  it("returns undefined for non-test output (never fabricates a summary)", () => {
    expect(summarizeTestOutput("Hello, world\nbuild succeeded", 0)).toBeUndefined();
    expect(summarizeTestOutput("", 0)).toBeUndefined();
    expect(summarizeTestOutput('echo "5 passed"', 0)).toBeUndefined(); // no framework markers
  });

  it("never reports a count that is not present in the raw output (property)", () => {
    const samples = [
      "===== 2 failed, 114 passed in 3.2s =====",
      "Tests:       2 failed, 10 passed, 12 total",
      "test result: FAILED. 3 passed; 2 failed; 0 ignored",
    ];
    for (const out of samples) {
      const parsed = parseTestOutput(out);
      expect(parsed).toBeDefined();
      for (const n of [parsed?.passed, parsed?.failed, parsed?.errors]) {
        if (n !== undefined) expect(out).toContain(String(n));
      }
    }
  });
});
