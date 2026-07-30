/**
 * Test-output summarization (Epic 1.12 slice 1 — observation normalization).
 *
 * A pure, conservative parser for common test-runner output. `bash.render` prepends a one-line
 * summary when one is recognized so the model gets a salient, reliable pass/fail signal up front
 * (it can decide it is *done* and stop, instead of eyeballing thousands of raw lines and guessing —
 * the over-editing root the 2026-06-18 measurement surfaced). This is STOP-enabling **information**,
 * not a behavioral nudge.
 *
 * Honesty contract: unrecognized output → `undefined` (never fabricate a summary); every reported
 * count is lifted verbatim from the raw text (never invented). The raw output is always preserved
 * below the summary — this slice ADDS signal, it does not drop anything (token savings via an
 * artifact-ref tail is a later, schema-gated slice).
 */

export interface TestSummary {
  /** The detected runner: "pytest" | "jest/vitest" | "cargo" | "go". */
  readonly framework: string;
  readonly passed?: number;
  readonly failed?: number;
  readonly errors?: number;
  /** Failing test ids/names, when the format exposes them (capped by the formatter). */
  readonly failures?: readonly string[];
}

/** First integer captured by `re` in `s`, or undefined. */
function num(re: RegExp, s: string): number | undefined {
  const m = re.exec(s);
  return m ? Number(m[1]) : undefined;
}

/** Trimmed lines of `output` (helper for line-oriented matchers). */
function lines(output: string): string[] {
  return output.split("\n").map((l) => l.trim());
}

function parsePytest(output: string): TestSummary | undefined {
  // The final summary line, e.g. `===== 2 failed, 114 passed in 3.21s =====`. Take the LAST such
  // banner line that carries a count word (skips the `=== FAILURES ===` header, which has none).
  const banner = lines(output)
    .filter(
      (l) => /^=+.*=+$/.test(l) && /\b(?:passed|failed|errors?|skipped|xfailed|xpassed)\b/.test(l),
    )
    .at(-1);
  if (banner === undefined) return undefined;
  const seg = banner.replace(/=+/g, " ");
  const passed = num(/(\d+) passed/, seg);
  const failed = num(/(\d+) failed/, seg);
  const errors = num(/(\d+) errors?/, seg);
  if (passed === undefined && failed === undefined && errors === undefined) return undefined;
  const failures = [...output.matchAll(/^FAILED\s+(\S+)/gm)].map((m) => m[1]!);
  return {
    framework: "pytest",
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
    ...(errors !== undefined ? { errors } : {}),
    ...(failures.length > 0 ? { failures } : {}),
  };
}

function parseJestVitest(output: string): TestSummary | undefined {
  // jest: `Tests:       2 failed, 10 passed, 12 total`; vitest: `Tests  2 failed | 10 passed (12)`.
  // Only the per-test `Tests` line — NOT vitest's `Test Files` line (which counts files, not tests).
  // Require a real summary SHAPE (a `total`/`|`/`(N)` marker), so a prose line that merely starts
  // "Tests:" and mentions "5 passed" is not mistaken for a result (QC false-positive fix).
  const line = lines(output)
    .filter(
      (l) =>
        /^Tests[:\s]/.test(l) &&
        /\b\d+\s+(?:passed|failed)\b/.test(l) &&
        /(?:\btotal\b|\||\(\d+\))/.test(l),
    )
    .at(-1);
  if (line === undefined) return undefined;
  const passed = num(/(\d+) passed/, line);
  const failed = num(/(\d+) failed/, line);
  if (passed === undefined && failed === undefined) return undefined;
  return {
    framework: "jest/vitest",
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
  };
}

function parseCargo(output: string): TestSummary | undefined {
  // `test result: ok. 5 passed; 0 failed; 0 ignored` / `test result: FAILED. 3 passed; 2 failed; …`
  // cargo emits one result line PER suite (unit tests + doctests), so SUM them — taking only the last
  // would mask the unit-test counts behind a (often-trivial) doctest line (QC fix).
  const resultLines = lines(output).filter((l) => /^test result:/.test(l));
  if (resultLines.length === 0) return undefined;
  let passed = 0;
  let failed = 0;
  let seen = false;
  for (const l of resultLines) {
    const p = num(/(\d+) passed/, l);
    const f = num(/(\d+) failed/, l);
    if (p !== undefined) {
      passed += p;
      seen = true;
    }
    if (f !== undefined) {
      failed += f;
      seen = true;
    }
  }
  return seen ? { framework: "cargo", passed, failed } : undefined;
}

function parseGo(output: string): TestSummary | undefined {
  // The unambiguous `go test -v` markers. Plain `go test` (no -v) prints only `ok pkg`/`FAIL pkg`,
  // which is too easily confused with arbitrary output — deferred to a later slice.
  const failures = [...output.matchAll(/^\s*--- FAIL:\s+(\S+)/gm)].map((m) => m[1]!);
  const passes = [...output.matchAll(/^\s*--- PASS:\s+(\S+)/gm)].length;
  if (failures.length === 0 && passes === 0) return undefined;
  return {
    framework: "go",
    ...(passes > 0 ? { passed: passes } : {}),
    ...(failures.length > 0 ? { failed: failures.length, failures } : {}),
  };
}

const MATCHERS = [parsePytest, parseJestVitest, parseCargo, parseGo];

/** Parse recognized test-runner output into a structured summary, or undefined. Pure. */
export function parseTestOutput(output: string): TestSummary | undefined {
  for (const m of MATCHERS) {
    const r = m(output);
    if (r !== undefined) return r;
  }
  return undefined;
}

const MAX_SHOWN_FAILURES = 5;

/**
 * One-line, model-facing summary of recognized test output, or undefined when nothing is recognized.
 * Verdict is FAIL if any failed/errors were parsed, or the command exited non-zero; else PASS.
 */
export function summarizeTestOutput(output: string, exitCode: number | null): string | undefined {
  const s = parseTestOutput(output);
  if (s === undefined) return undefined;
  const failedish = (s.failed ?? 0) + (s.errors ?? 0);
  const verdict = failedish > 0 || (exitCode !== 0 && exitCode !== null) ? "FAIL" : "PASS";
  const counts: string[] = [];
  if (s.passed !== undefined) counts.push(`${String(s.passed)} passed`);
  if (s.failed !== undefined) counts.push(`${String(s.failed)} failed`);
  if (s.errors !== undefined) counts.push(`${String(s.errors)} error${s.errors === 1 ? "" : "s"}`);
  let line = `TEST SUMMARY (${s.framework}): ${verdict}`;
  if (counts.length > 0) line += ` — ${counts.join(", ")}`;
  if (s.failures && s.failures.length > 0) {
    line += `; failing: ${s.failures.slice(0, MAX_SHOWN_FAILURES).join(", ")}`;
    if (s.failures.length > MAX_SHOWN_FAILURES) {
      line += ` (+${String(s.failures.length - MAX_SHOWN_FAILURES)} more)`;
    }
  }
  return line;
}
