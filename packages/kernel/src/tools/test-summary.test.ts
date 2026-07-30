import { describe, expect, it } from "vitest";
import { parseTestOutput, summarizeTestOutput } from "./test-summary.js";

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
