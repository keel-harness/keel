import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { LoopDetector, bashFullFileRewriteTarget, fileFamily } from "./loop-detection.js";

describe("LoopDetector", () => {
  it("n-gram: trips on N consecutive identical tool-call signatures", () => {
    const d = new LoopDetector({ maxToolRepeats: 3 });
    expect(d.record({ name: "echo", args: { x: 1 } })).toBeUndefined();
    expect(d.record({ name: "echo", args: { x: 1 } })).toBeUndefined();
    expect(d.record({ name: "echo", args: { x: 1 } })).toMatchObject({
      signal: "tool-repeat",
      detail: "echo",
    });
  });

  it("n-gram: a different signature resets the consecutive run", () => {
    const d = new LoopDetector({ maxToolRepeats: 3 });
    d.record({ name: "echo", args: { x: 1 } });
    d.record({ name: "echo", args: { x: 1 } });
    expect(d.record({ name: "echo", args: { x: 2 } })).toBeUndefined(); // different args -> reset to 1
    expect(d.record({ name: "echo", args: { x: 2 } })).toBeUndefined(); // 2
    expect(d.record({ name: "echo", args: { x: 2 } })).toMatchObject({
      signal: "tool-repeat",
      detail: "echo",
    });
  });

  it("per-file: trips after N edits to the same path (parameterized edit tools + path arg)", () => {
    const d = new LoopDetector({ maxFileEdits: 3, editTools: ["write"], pathArg: "path" });
    // interleave distinct args so the n-gram signal never fires — isolate the per-file signal
    expect(d.record({ name: "write", args: { path: "a.ts", v: 1 } })).toBeUndefined();
    expect(d.record({ name: "write", args: { path: "a.ts", v: 2 } })).toBeUndefined();
    expect(d.record({ name: "write", args: { path: "a.ts", v: 3 } })).toEqual({
      signal: "file-edits",
      detail: "a.ts",
      advisory: true, // warn-only (Epic 1.16 loop-detector fix) — never halts legit iteration
    });
  });

  it("per-file: edits to different files are counted separately; non-edit tools ignored", () => {
    const d = new LoopDetector({ maxFileEdits: 2, editTools: ["write"], pathArg: "path" });
    expect(d.record({ name: "write", args: { path: "a.ts", v: 1 } })).toBeUndefined();
    expect(d.record({ name: "write", args: { path: "b.ts", v: 1 } })).toBeUndefined();
    expect(d.record({ name: "read", args: { path: "a.ts" } })).toBeUndefined(); // not an edit tool
    expect(d.record({ name: "write", args: { path: "a.ts", v: 2 } })).toEqual({
      signal: "file-edits",
      detail: "a.ts",
      advisory: true,
    });
  });

  it("per-file: the signal is ADVISORY (warn-only) — repeated edits past the threshold NEVER escalate to a halting signal (Epic 1.16 over-fire fix)", () => {
    // The benchmark over-fires were legitimate iterative refinement of ONE file on a hard task, killed at
    // the threshold. Now every trip is advisory, so the loop only warns+redirects and the run is never
    // halted by per-file churn (the hard runaway stops are the n-gram cycle detector + gross/turn caps).
    const d = new LoopDetector({ maxFileEdits: 2, editTools: ["write"], pathArg: "path" });
    expect(d.record({ name: "write", args: { path: "f.ts", v: 1 } })).toBeUndefined();
    for (let v = 2; v <= 12; v++) {
      const sig = d.record({ name: "write", args: { path: "f.ts", v } });
      // every trip past the threshold is advisory — there is no non-advisory (halting) per-file signal
      expect(sig).toEqual({ signal: "file-edits", detail: "f.ts", advisory: true });
    }
  });

  it("outcome-stall: trips on repeated equivalent tool results even when tool inputs vary", () => {
    const d = new LoopDetector({ maxToolRepeats: 99, maxOutcomeRepeats: 3 });
    const calls = [
      { name: "bash", args: { command: "pytest -q --step=1" } },
      { name: "bash", args: { command: "pytest -q --step=2" } },
      { name: "bash", args: { command: "pytest -q --step=3" } },
    ];

    expect(
      d.recordResult(calls[0]!, "FAILED tests/test_api.py::test_handles_empty_input\n"),
    ).toBeUndefined();
    expect(
      d.recordResult(calls[1]!, "FAILED tests/test_api.py::test_handles_empty_input\n"),
    ).toBeUndefined();
    const signal = d.recordResult(
      calls[2]!,
      "FAILED tests/test_api.py::test_handles_empty_input\n",
    );

    expect(signal).toMatchObject({ signal: "tool-repeat" });
    expect(signal?.detail).toContain("equivalent outcome");
    expect(signal?.advisory).toBeUndefined();
  });

  it("outcome-stall: monotonic LaTeX overfull improvement does not false-trip", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 2,
      maxObjectiveStallTurns: 3,
    });
    const values = [12.8, 8.4, 3.2, 0.7];
    for (const [i, value] of values.entries()) {
      expect(
        d.recordResult(
          { name: "bash", args: { command: `pdflatex main-${String(i)}.tex | grep Overfull` } },
          `Overfull \\hbox (${String(value)}pt too wide) in paragraph at lines 12--13\n`,
        ),
      ).toBeUndefined();
    }
  });

  it("outcome-stall: monotonic labeled numeric improvement does not collapse through number erasure", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 3,
      maxObjectiveStallTurns: 2,
    });
    const losses = [1.0, 0.92, 0.84, 0.75, 0.64];

    for (const [i, loss] of losses.entries()) {
      expect(
        d.recordResult(
          { name: "bash", args: { command: `python train.py --attempt=${String(i)}` } },
          `validation loss: ${loss.toFixed(2)}\n`,
        ),
      ).toBeUndefined();
    }
  });

  it("objective-stall: tracks visible LaTeX contexts separately instead of one global best", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 0,
      maxObjectiveStallTurns: 3,
    });
    const observations = [
      ["intro.tex", 10],
      ["intro.tex", 1],
      ["appendix.tex", 50],
      ["appendix.tex", 40],
      ["appendix.tex", 30],
      ["appendix.tex", 20],
    ] as const;

    for (const [file, value] of observations) {
      expect(
        d.recordResult(
          { name: "bash", args: { command: `pdflatex ${file} | grep Overfull` } },
          `Overfull \\hbox (${String(value)}pt too wide) in ${file} at lines 12--13\n`,
        ),
      ).toBeUndefined();
    }
  });

  it("objective-stall: tracks scalar metric contexts separately instead of one global best", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 0,
      maxObjectiveStallTurns: 2,
    });

    expect(
      d.recordResult({ name: "bash", args: { command: "pytest tests/unit -q" } }, "0 failed\n"),
    ).toBeUndefined();
    for (const failed of [12, 8, 4, 0]) {
      expect(
        d.recordResult(
          { name: "bash", args: { command: "pytest tests/integration -q" } },
          `${String(failed)} failed\n`,
        ),
      ).toBeUndefined();
    }
  });

  it("objective-stall: trips when LaTeX overfull progress stops improving", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 0,
      maxObjectiveStallTurns: 3,
    });
    const values = [12.8, 8.4, 8.4, 8.6, 8.5];
    let signal: ReturnType<LoopDetector["recordResult"]> | undefined;
    for (const [i, value] of values.entries()) {
      signal = d.recordResult(
        { name: "bash", args: { command: `pdflatex pass-${String(i)}.tex | grep Overfull` } },
        `Overfull \\hbox (${String(value)}pt too wide) in paragraph at lines 12--13\n`,
      );
    }
    expect(signal).toMatchObject({ signal: "tool-repeat" });
    expect(signal?.detail).toContain("latex-overfull stalled");
  });

  it("outcome-stall: high-burn repeated equivalent output uses a shorter calibrated patience", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 8,
      highBurnOutcomeRepeats: 3,
      highBurnOutputBytes: 32,
    });
    const output = "FAILED tests/test_video.py::test_takeoff_landing\n".repeat(4);

    expect(
      d.recordResult({ name: "bash", args: { command: "pytest -q --attempt=1" } }, output),
    ).toBeUndefined();
    expect(
      d.recordResult({ name: "bash", args: { command: "pytest -q --attempt=2" } }, output),
    ).toBeUndefined();
    const signal = d.recordResult(
      { name: "bash", args: { command: "pytest -q --attempt=3" } },
      output,
    );

    expect(signal).toMatchObject({ signal: "tool-repeat" });
    expect(signal?.detail).toContain("high-burn");
  });

  it("outcome-stall: high-burn monotonic accuracy is not collapsed by number erasure", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 8,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 32,
    });

    for (const [i, accuracy] of [0.71, 0.74, 0.78, 0.81].entries()) {
      expect(
        d.recordResult(
          { name: "bash", args: { command: `python score.py --attempt=${String(i)}` } },
          `accuracy: ${accuracy.toFixed(2)}\n`.repeat(8),
        ),
      ).toBeUndefined();
    }
  });

  it("outcome-stall: high-burn threshold is measured in output bytes, not UTF-16 code units", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 99,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 32,
    });
    const output = "é".repeat(16);

    expect(
      d.recordResult({ name: "bash", args: { command: "pytest -q --attempt=1" } }, output),
    ).toBeUndefined();
    const signal = d.recordResult(
      { name: "bash", args: { command: "pytest -q --attempt=2" } },
      output,
    );

    expect(signal?.detail).toContain("high-burn");
  });

  it("outcome-stall: high token-cost tiny failure outputs use shorter calibrated patience", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 8,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 4096,
      highBurnStepTokens: 10_000,
    });
    const output = "search failed: no candidate changed\n";

    expect(
      d.recordResult({ name: "bash", args: { command: "python search.py --attempt=1" } }, output, {
        stepTokens: 50_000,
      }),
    ).toBeUndefined();
    const signal = d.recordResult(
      { name: "bash", args: { command: "python search.py --attempt=2" } },
      output,
      { stepTokens: 50_000 },
    );

    expect(signal).toMatchObject({ signal: "tool-repeat" });
    expect(signal?.detail).toContain("high-burn equivalent outcome");
  });

  it("progress-ledger: high-cost silent verifier success is progress, not outcome-stall", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 8,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 4096,
      highBurnStepTokens: 10_000,
    });
    const output = "(command produced no output; exit code 0)\n";

    for (const attempt of [1, 2, 3, 4]) {
      expect(
        d.recordResult(
          { name: "bash", args: { command: `pytest -q --attempt=${String(attempt)}` } },
          output,
          { stepTokens: 50_000 },
        ),
      ).toBeUndefined();
    }
  });

  it("progress-ledger: exact repeated silent verifier success suppresses terminal n-gram repeats", () => {
    const d = new LoopDetector({
      maxToolRepeats: 2,
      highBurnToolRepeats: 2,
      highBurnToolStepTokens: 10_000,
    });
    const call = { name: "bash", args: { command: "pytest -q" } };
    const output = "(command produced no output; exit code 0)\n";

    expect(d.recordResult(call, output, { stepTokens: 50_000 })).toBeUndefined();
    expect(d.recordResult(call, output, { stepTokens: 50_000 })).toBeUndefined();
    expect(d.recordResult(call, output, { stepTokens: 50_000 })).toBeUndefined();
  });

  it("progress-ledger: a direct goal-check remains generic unknown and cannot reset or suppress a loop signal", () => {
    const d = new LoopDetector({
      maxToolRepeats: 2,
      maxOutcomeRepeats: 99,
    });
    const call = { name: "bash", args: { command: "node goal-check.mjs" } };
    const output = JSON.stringify({ exitCode: 0, signal: null, stdout: "", stderr: "" });
    const initialEpoch = d.progressEpoch();

    expect(d.recordResult(call, output, { resultOk: true })).toBeUndefined();
    expect(d.progressEpoch()).toBe(initialEpoch);
    expect(d.recordResult(call, output, { resultOk: true })).toMatchObject({
      signal: "tool-repeat",
    });
    expect(d.progressEpoch()).toBe(initialEpoch);
  });

  it("progress-ledger: edit progress resets high-burn repeated traceback evidence", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 8,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 64,
    });
    const failure = "Traceback (most recent call last):\nAssertionError: same bug\n".repeat(4);

    expect(
      d.recordResult({ name: "bash", args: { command: "pytest -q --attempt=1" } }, failure),
    ).toBeUndefined();
    expect(
      d.recordResult(
        {
          name: "edit",
          args: { path: "src/app.py", oldString: "before 1", newString: "after 1" },
        },
        "edited src/app.py\n",
      ),
    ).toBeUndefined();
    expect(
      d.recordResult({ name: "bash", args: { command: "pytest -q --attempt=2" } }, failure),
    ).toBeUndefined();
    expect(
      d.recordResult(
        {
          name: "edit",
          args: { path: "src/app.py", oldString: "before 2", newString: "after 2" },
        },
        "edited src/app.py\n",
      ),
    ).toBeUndefined();
    expect(
      d.recordResult({ name: "bash", args: { command: "pytest -q --attempt=3" } }, failure),
    ).toBeUndefined();
  });

  it("progress-ledger: failed edits do not reset high-burn repeated traceback evidence", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 8,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 64,
    });
    const failure = "Traceback (most recent call last):\nAssertionError: same bug\n".repeat(4);

    expect(
      d.recordResult({ name: "bash", args: { command: "pytest -q --attempt=1" } }, failure),
    ).toBeUndefined();
    expect(
      d.recordResult(
        {
          name: "edit",
          args: { path: "src/app.py", oldString: "missing", newString: "after" },
        },
        "oldString not found\n",
        { resultOk: false },
      ),
    ).toBeUndefined();
    expect(
      d.recordResult({ name: "bash", args: { command: "pytest -q --attempt=2" } }, failure),
    ).toMatchObject({ signal: "tool-repeat" });
  });

  it("progress-ledger: no-op edits do not reset high-burn repeated traceback evidence", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 8,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 64,
    });
    const failure = "Traceback (most recent call last):\nAssertionError: same bug\n".repeat(4);

    expect(
      d.recordResult({ name: "bash", args: { command: "pytest -q --attempt=1" } }, failure),
    ).toBeUndefined();
    expect(
      d.recordResult(
        {
          name: "edit",
          args: { path: "src/app.py", oldString: "before", newString: "before" },
        },
        "no changes made\n",
      ),
    ).toBeUndefined();
    expect(
      d.recordResult({ name: "bash", args: { command: "pytest -q --attempt=2" } }, failure),
    ).toMatchObject({ signal: "tool-repeat" });
  });

  it("progress-ledger: idempotent control output is bounded low-confidence loop evidence", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 2,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 16,
    });
    const output = "refreshing the postfix mail system\n";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        d.recordResult({ name: "bash", args: { command: "service postfix reload" } }, output),
      ).toBeUndefined();
    }
    expect(
      d.recordResult({ name: "bash", args: { command: "service postfix reload" } }, output),
    ).toMatchObject({
      signal: "tool-repeat",
      advisory: true,
    });
  });

  it("progress-ledger: poll output with unknown process state is bounded and non-terminal", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 2,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 16,
    });
    const output = "0 password hashes cracked, 1 left\n";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        d.recordResult({ name: "bash", args: { command: "john --show hash.txt" } }, output),
      ).toBeUndefined();
    }
    expect(
      d.recordResult({ name: "bash", args: { command: "john --show hash.txt" } }, output),
    ).toMatchObject({
      signal: "tool-repeat",
      advisory: true,
    });
  });

  it("progress-ledger: noisy poll output still reaches the low-confidence advisory", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      lowConfidenceRepeatAdvisoryRepeats: 3,
    });

    expect(
      d.recordResult(
        { name: "bash", args: { command: "curl -fsS http://127.0.0.1:8000/health" } },
        "healthy at 10:01:01\n",
      ),
    ).toBeUndefined();
    expect(
      d.recordResult(
        { name: "bash", args: { command: "curl -fsS http://127.0.0.1:8000/health" } },
        "healthy at 10:01:02\n",
      ),
    ).toBeUndefined();
    expect(
      d.recordResult(
        { name: "bash", args: { command: "curl -fsS http://127.0.0.1:8000/health" } },
        "healthy at 10:01:03\n",
      ),
    ).toMatchObject({
      signal: "tool-repeat",
      advisory: true,
    });
  });

  it("progress-ledger: failed poll results remain eligible for hard loop detection", () => {
    const d = new LoopDetector({
      maxToolRepeats: 2,
      maxOutcomeRepeats: 2,
      highBurnToolRepeats: 2,
      highBurnToolStepTokens: 10_000,
    });
    const call = { name: "bash", args: { command: "john --show hash.txt" } };
    const output = "0 password hashes cracked, 1 left\n";

    expect(d.recordResult(call, output, { resultOk: false, stepTokens: 50_000 })).toBeUndefined();
    expect(d.recordResult(call, output, { resultOk: false, stepTokens: 50_000 })).toMatchObject({
      signal: "tool-repeat",
    });
  });

  it("progress-ledger: repeated same-command build output with changing non-failure text is progress", () => {
    const d = new LoopDetector({
      maxToolRepeats: 2,
      maxOutcomeRepeats: 2,
    });
    const call = { name: "bash", args: { command: "make -j2 world" } };

    expect(d.recordResult(call, "make: completed 1/4 units\n")).toBeUndefined();
    expect(d.recordResult(call, "make: completed 2/4 units\n")).toBeUndefined();
    expect(d.recordResult(call, "make: completed 3/4 units\n")).toBeUndefined();
  });

  it("outcome-stall: low token-cost tiny outputs keep normal patience", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 4,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 4096,
      highBurnStepTokens: 10_000,
    });
    const output = "(command produced no output; exit code 0)\n";

    for (const attempt of [1, 2, 3]) {
      expect(
        d.recordResult(
          { name: "bash", args: { command: `python search.py --attempt=${String(attempt)}` } },
          output,
          { stepTokens: 500 },
        ),
      ).toBeUndefined();
    }
  });

  it("outcome-stall: tool-cycle token threshold does not shorten generic outcomes", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 4,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 4096,
      highBurnToolStepTokens: 10_000,
    });
    const output = "(command produced no output; exit code 0)\n";

    for (const attempt of [1, 2, 3]) {
      expect(
        d.recordResult(
          { name: "bash", args: { command: `python search.py --attempt=${String(attempt)}` } },
          output,
          { stepTokens: 50_000 },
        ),
      ).toBeUndefined();
    }
  });

  it("n-gram: high token-cost exact repeats can use shorter calibrated patience", () => {
    const d = new LoopDetector({
      maxToolRepeats: 3,
      highBurnToolRepeats: 2,
      highBurnStepTokens: 10_000,
    });
    const call = { name: "bash", args: { command: "python expensive_check.py" } };

    expect(d.record(call, { stepTokens: 50_000 })).toBeUndefined();
    const signal = d.record(call, { stepTokens: 50_000 });
    expect(signal).toMatchObject({ signal: "tool-repeat" });
    expect(signal?.detail).toContain("high-burn exact input");
  });

  it("n-gram: low token-cost exact repeats keep normal patience", () => {
    const d = new LoopDetector({
      maxToolRepeats: 3,
      highBurnToolRepeats: 2,
      highBurnStepTokens: 10_000,
    });
    const call = { name: "bash", args: { command: "python cheap_check.py" } };

    expect(d.record(call, { stepTokens: 500 })).toBeUndefined();
    expect(d.record(call, { stepTokens: 500 })).toBeUndefined();
    expect(d.record(call, { stepTokens: 500 })).toMatchObject({
      signal: "tool-repeat",
      detail: "bash",
    });
  });

  it("reset(signal) preserves a warned high-burn outcome fingerprint for fast terminal recurrence", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 8,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 4096,
      highBurnStepTokens: 10_000,
    });
    const output = "search failed: no candidate changed\n";

    expect(
      d.recordResult({ name: "bash", args: { command: "python search.py --attempt=1" } }, output, {
        stepTokens: 50_000,
      }),
    ).toBeUndefined();
    const warning = d.recordResult(
      { name: "bash", args: { command: "python search.py --attempt=2" } },
      output,
      { stepTokens: 50_000 },
    );
    expect(warning).toMatchObject({ signal: "tool-repeat" });

    d.reset(warning);

    const recurrence = d.recordResult(
      { name: "bash", args: { command: "python search.py --attempt=3" } },
      output,
      { stepTokens: 50_000 },
    );
    expect(recurrence).toMatchObject({ signal: "tool-repeat" });
    expect(recurrence?.detail).toContain("after warning");
  });

  it("reset(signal) expires a warned high-burn outcome fingerprint after different evidence", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 8,
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 4096,
      highBurnStepTokens: 10_000,
    });
    const output = "search failed: no candidate changed\n";

    expect(
      d.recordResult({ name: "bash", args: { command: "python search.py --attempt=1" } }, output, {
        stepTokens: 50_000,
      }),
    ).toBeUndefined();
    const warning = d.recordResult(
      { name: "bash", args: { command: "python search.py --attempt=2" } },
      output,
      { stepTokens: 50_000 },
    );
    expect(warning).toMatchObject({ signal: "tool-repeat" });

    d.reset(warning);

    expect(
      d.recordResult(
        { name: "bash", args: { command: "python different.py" } },
        "different failure\n",
        { stepTokens: 50_000 },
      ),
    ).toBeUndefined();
    expect(
      d.recordResult({ name: "bash", args: { command: "python search.py --attempt=3" } }, output, {
        stepTokens: 50_000,
      }),
    ).toBeUndefined();
  });

  it("reset(signal) preserves a warned high-burn exact-repeat fingerprint for fast terminal recurrence", () => {
    const d = new LoopDetector({
      maxToolRepeats: 3,
      highBurnToolRepeats: 2,
      highBurnToolStepTokens: 10_000,
    });
    const call = { name: "bash", args: { command: "python expensive_check.py" } };

    expect(d.record(call, { stepTokens: 50_000 })).toBeUndefined();
    const warning = d.record(call, { stepTokens: 50_000 });
    expect(warning).toMatchObject({ signal: "tool-repeat" });

    d.reset(warning);

    const recurrence = d.record(call, { stepTokens: 50_000 });
    expect(recurrence).toMatchObject({ signal: "tool-repeat" });
    expect(recurrence?.detail).toContain("after warning");
  });

  it("reset(signal) preserves a warned alternating-cycle fingerprint for fast forced-pivot recurrence", () => {
    const d = new LoopDetector({ maxToolRepeats: 2 });
    const a = { name: "A", args: {} };
    const b = { name: "B", args: {} };

    expect(d.record(a)).toBeUndefined();
    expect(d.record(b)).toBeUndefined();
    expect(d.record(a)).toBeUndefined();
    const warning = d.record(b);
    expect(warning).toMatchObject({ signal: "tool-repeat", detail: "A,B" });

    d.reset(warning);

    const forcedPivot = d.record(a);
    expect(forcedPivot).toMatchObject({ signal: "tool-repeat" });
    expect(forcedPivot?.detail).toContain("warned 2-step cycle");

    d.reset(forcedPivot);

    const terminal = d.record(a);
    expect(terminal).toMatchObject({ signal: "tool-repeat" });
    expect(terminal?.detail).toContain("warned 2-step cycle");
  });

  it("reset(signal) expires a warned high-burn exact-repeat fingerprint after a different call", () => {
    const d = new LoopDetector({
      maxToolRepeats: 3,
      highBurnToolRepeats: 2,
      highBurnToolStepTokens: 10_000,
    });
    const call = { name: "bash", args: { command: "python expensive_check.py" } };

    expect(d.record(call, { stepTokens: 50_000 })).toBeUndefined();
    const warning = d.record(call, { stepTokens: 50_000 });
    expect(warning).toMatchObject({ signal: "tool-repeat" });

    d.reset(warning);

    expect(
      d.record(
        { name: "bash", args: { command: "python different_check.py" } },
        {
          stepTokens: 50_000,
        },
      ),
    ).toBeUndefined();
    expect(d.record(call, { stepTokens: 50_000 })).toBeUndefined();
  });

  it("numeric-vector: catches bounded oscillation without relying on exact output equality", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 99,
      maxNumericVectorStallTurns: 5,
      numericVectorBand: 5,
    });
    const observations = [
      [48, 75],
      [5, 6],
      [48, 73],
      [48, 72],
      [47, 75],
      [46, 75],
      [49, 73],
    ] as const;
    let signal: ReturnType<LoopDetector["recordResult"]> | undefined;

    for (const [i, [takeoff, landing]] of observations.entries()) {
      signal = d.recordResult(
        { name: "bash", args: { command: `python jump_analyzer.py --attempt=${String(i)}` } },
        `Takeoff: ${String(takeoff)}\nLanding: ${String(landing)}\n`,
      );
    }

    expect(signal).toMatchObject({ signal: "tool-repeat" });
    expect(signal?.detail).toContain("numeric-vector oscillation");
  });

  it("numeric-vector: catches a stable repeated vector instead of suppressing generic stall detection", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 99,
      maxNumericVectorStallTurns: 5,
      numericVectorBand: 5,
    });
    let signal: ReturnType<LoopDetector["recordResult"]> | undefined;

    for (let i = 0; i < 5; i++) {
      signal = d.recordResult(
        { name: "bash", args: { command: `python jump_analyzer.py --attempt=${String(i)}` } },
        "Takeoff: 48\nLanding: 75\n",
      );
    }

    expect(signal).toMatchObject({ signal: "tool-repeat" });
    expect(signal?.detail).toContain("numeric-vector stalled");
  });

  it("numeric-vector: generic diagnostics are not treated as production hard vector evidence", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 99,
      maxNumericVectorStallTurns: 5,
      numericVectorBand: 5,
    });
    const diagnostics = [
      [12, 5],
      [14, 7],
      [11, 6],
      [13, 5],
      [12, 8],
      [14, 6],
      [11, 7],
    ] as const;

    for (const [i, [line, column]] of diagnostics.entries()) {
      expect(
        d.recordResult(
          { name: "bash", args: { command: `tsc --pretty false --attempt=${String(i)}` } },
          `error TS2322: type mismatch\nline: ${String(line)}\ncolumn: ${String(column)}\n`,
        ),
      ).toBeUndefined();
    }
  });

  it("numeric-vector: monotonic convergence does not trip the oscillation guard", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxOutcomeRepeats: 99,
      maxNumericVectorStallTurns: 5,
      numericVectorBand: 5,
    });
    const observations = [
      [90, 120],
      [75, 105],
      [60, 90],
      [45, 75],
      [30, 60],
      [15, 45],
      [5, 30],
    ] as const;

    for (const [i, [takeoff, landing]] of observations.entries()) {
      expect(
        d.recordResult(
          { name: "bash", args: { command: `python jump_analyzer.py --attempt=${String(i)}` } },
          `Takeoff: ${String(takeoff)}\nLanding: ${String(landing)}\n`,
        ),
      ).toBeUndefined();
    }
  });

  it("property: monotonic labeled scalar improvement never trips progress-stall detection", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 3, maxLength: 12 }),
        (deltas) => {
          const start = deltas.reduce((sum, n) => sum + n, 100);
          let value = start;
          const d = new LoopDetector({
            maxToolRepeats: 999,
            maxOutcomeRepeats: 2,
            maxObjectiveStallTurns: 2,
          });
          for (const [i, delta] of deltas.entries()) {
            value -= delta;
            expect(
              d.recordResult(
                { name: "bash", args: { command: `python train.py --attempt=${String(i)}` } },
                `validation loss: ${String(value)}\n`,
              ),
            ).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("property: monotonic numeric-vector convergence never trips bounded-oscillation detection", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 6, max: 30 }), { minLength: 5, maxLength: 12 }),
        (steps) => {
          const d = new LoopDetector({
            maxToolRepeats: 999,
            maxOutcomeRepeats: 999,
            maxNumericVectorStallTurns: 5,
            numericVectorBand: 5,
          });
          let takeoff = steps.reduce((sum, n) => sum + n, 50);
          let landing = takeoff + 30;
          for (const [i, step] of steps.entries()) {
            takeoff -= step;
            landing -= step;
            expect(
              d.recordResult(
                {
                  name: "bash",
                  args: { command: `python jump_analyzer.py --attempt=${String(i)}` },
                },
                `Takeoff: ${String(takeoff)}\nLanding: ${String(landing)}\n`,
              ),
            ).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("edit-oscillation: catches inverse edit churn without making one revert terminal", () => {
    const d = new LoopDetector({ maxToolRepeats: 99, maxEditOscillations: 2 });
    expect(
      d.record({
        name: "edit",
        args: { path: "layout.tex", oldString: "margin=1in", newString: "margin=0.9in" },
      }),
    ).toBeUndefined();
    expect(
      d.record({
        name: "edit",
        args: { path: "layout.tex", oldString: "margin=0.9in", newString: "margin=1in" },
      }),
    ).toBeUndefined();
    const signal = d.record({
      name: "edit",
      args: { path: "layout.tex", oldString: "margin=1in", newString: "margin=0.9in" },
    });
    expect(signal).toMatchObject({ signal: "tool-repeat" });
    expect(signal?.detail).toContain("oscillating edit");
  });

  it("resetAdvisory() clears advisory file counters but preserves hard outcome evidence", () => {
    const d = new LoopDetector({
      maxToolRepeats: 99,
      maxFileEdits: 2,
      maxOutcomeRepeats: 3,
      editTools: ["write"],
    });

    expect(
      d.recordResult({ name: "bash", args: { command: "check --pass=1" } }, "same failure"),
    ).toBeUndefined();
    expect(d.record({ name: "write", args: { path: "a.ts", content: "one" } })).toBeUndefined();
    expect(d.record({ name: "write", args: { path: "a.ts", content: "two" } })).toEqual({
      signal: "file-edits",
      detail: "a.ts",
      advisory: true,
    });

    d.resetAdvisory();

    expect(
      d.recordResult({ name: "bash", args: { command: "check --pass=2" } }, "same failure"),
    ).toBeUndefined();
    expect(
      d.recordResult({ name: "bash", args: { command: "check --pass=3" } }, "same failure"),
    ).toMatchObject({
      signal: "tool-repeat",
    });
  });

  it("reset() clears both signals", () => {
    const d = new LoopDetector({ maxToolRepeats: 2 });
    d.record({ name: "echo", args: {} });
    d.reset();
    expect(d.record({ name: "echo", args: {} })).toBeUndefined(); // counter restarted at 1
  });

  it("uses sensible defaults (maxToolRepeats=3) when unconfigured", () => {
    const d = new LoopDetector();
    expect(d.record({ name: "edit", args: { path: "x" } })).toBeUndefined(); // 1
    expect(d.record({ name: "edit", args: { path: "x" } })).toBeUndefined(); // 2
    expect(d.record({ name: "edit", args: { path: "x" } })).toMatchObject({
      signal: "tool-repeat",
      detail: "edit",
    }); // 3
  });

  it("n-gram: detects an alternating A-B-A-B cycle at the repeat threshold", () => {
    const d = new LoopDetector({ maxToolRepeats: 3 });
    const a = { name: "A", args: {} };
    const b = { name: "B", args: {} };
    expect(d.record(a)).toBeUndefined(); // A
    expect(d.record(b)).toBeUndefined(); // A B
    expect(d.record(a)).toBeUndefined(); // A B A
    expect(d.record(b)).toBeUndefined(); // A B A B  (2 cycles)
    expect(d.record(a)).toBeUndefined(); // A B A B A
    expect(d.record(b)).toMatchObject({ signal: "tool-repeat", detail: "A,B" }); // 3 cycles -> trip
  });

  it("n-gram: a non-repeating sequence never trips", () => {
    const d = new LoopDetector({ maxToolRepeats: 3 });
    for (const name of ["A", "B", "C", "D", "E", "A", "C", "B"]) {
      expect(d.record({ name, args: {} })).toBeUndefined();
    }
  });

  it("signature is canonical: arg key order does not affect repeat detection", () => {
    const d = new LoopDetector({ maxToolRepeats: 2 });
    expect(d.record({ name: "f", args: { a: 1, b: 2 } })).toBeUndefined();
    // same call with keys reordered must be the SAME signature -> trips at 2.
    expect(d.record({ name: "f", args: { b: 2, a: 1 } })).toMatchObject({
      signal: "tool-repeat",
      detail: "f",
    });
  });

  it("signature ignores inert bash analysis/plan fields so repeated commands cannot evade detection", () => {
    const d = new LoopDetector({ maxToolRepeats: 3 });
    expect(
      d.record({
        name: "bash",
        args: { command: "pnpm test", analysis: "try tests first" },
      }),
    ).toBeUndefined();
    expect(
      d.record({
        name: "bash",
        args: { command: "pnpm test", plan: "same command again" },
      }),
    ).toBeUndefined();
    expect(
      d.record({
        name: "bash",
        args: {
          command: "pnpm test",
          analysis: "different scratchpad",
          plan: "still same command",
        },
      }),
    ).toMatchObject({ signal: "tool-repeat", detail: "bash" });
  });

  it("signature ignores the inert bash timeoutMs field so a perturbed timeout cannot evade detection", () => {
    const d = new LoopDetector({ maxToolRepeats: 3 });
    // Same executable command, only the inert resource-bound `timeoutMs` perturbed each turn — this
    // must NOT defeat cycle detection (the n-gram detector is the only HARD loop halt).
    expect(
      d.record({ name: "bash", args: { command: "pnpm test", timeoutMs: 120000 } }),
    ).toBeUndefined();
    expect(
      d.record({ name: "bash", args: { command: "pnpm test", timeoutMs: 120001 } }),
    ).toBeUndefined();
    expect(
      d.record({ name: "bash", args: { command: "pnpm test", timeoutMs: 120002 } }),
    ).toMatchObject({
      signal: "tool-repeat",
      detail: "bash",
    });
  });

  it("canonical signature handles nested arrays: sibling-key order ignored, element order significant", () => {
    const sameArray = new LoopDetector({ maxToolRepeats: 2 });
    expect(sameArray.record({ name: "f", args: { paths: ["a", "b"], mode: 1 } })).toBeUndefined();
    // sibling keys reordered, identical array -> SAME signature -> trips at 2.
    expect(sameArray.record({ name: "f", args: { mode: 1, paths: ["a", "b"] } })).toMatchObject({
      signal: "tool-repeat",
      detail: "f",
    });

    const diffOrder = new LoopDetector({ maxToolRepeats: 2 });
    expect(diffOrder.record({ name: "f", args: { paths: ["a", "b"] } })).toBeUndefined();
    // array ELEMENT order differs -> different signature -> must NOT collapse.
    expect(diffOrder.record({ name: "f", args: { paths: ["b", "a"] } })).toBeUndefined();
  });
});

describe("bashFullFileRewriteTarget (Epic 1.13 — narrowed shell full-file-rewrite extraction)", () => {
  it("extracts a heredoc-to-file rewrite (the measured ER-037 anti-pattern)", () => {
    expect(bashFullFileRewriteTarget("cat <<'EOF' > build_gates.py\nprint(1)\nEOF")).toBe(
      "build_gates.py",
    );
    expect(bashFullFileRewriteTarget("cat <<EOF > out.txt\nx\nEOF")).toBe("out.txt"); // unquoted delim
    expect(bashFullFileRewriteTarget("cat > out.txt <<EOF\nx\nEOF")).toBe("out.txt"); // redirect first
  });

  it("unquotes a quoted heredoc target (handles spaces)", () => {
    expect(bashFullFileRewriteTarget('cat <<EOF > "a b.py"\nx\nEOF')).toBe("a b.py");
  });

  it("extracts a tee target but NOT tee -a (append)", () => {
    expect(bashFullFileRewriteTarget("echo hi | tee config.json")).toBe("config.json");
    expect(bashFullFileRewriteTarget("echo hi | tee -a config.json")).toBeUndefined();
  });

  it("does NOT count plain redirects — appends, stderr, or build output (QC: avoid false halts)", () => {
    // No heredoc -> not a whole-file emission. These are legitimate, repeatable operations.
    expect(bashFullFileRewriteTarget("python x.py > out.txt")).toBeUndefined(); // build output redirect
    expect(bashFullFileRewriteTarget("echo x >> log")).toBeUndefined(); // append (file grows, not rewrite)
    expect(bashFullFileRewriteTarget("printf hi >| clobber.txt")).toBeUndefined(); // no heredoc
    expect(bashFullFileRewriteTarget("make 2> errors.log")).toBeUndefined(); // stderr capture
    expect(bashFullFileRewriteTarget("npm run build > dist/bundle.js")).toBeUndefined();
  });

  it("does NOT extract a redirect token inside quotes (QC: the awk '$1>5' phantom)", () => {
    expect(bashFullFileRewriteTarget("awk '$1>5' data.csv")).toBeUndefined();
    expect(bashFullFileRewriteTarget("python -c 'print(1>2)'")).toBeUndefined();
  });

  it("ignores /dev/* sinks, fd-dups, substrings, and non-writing commands", () => {
    expect(bashFullFileRewriteTarget("cat <<EOF > /dev/null\nx\nEOF")).toBeUndefined();
    expect(bashFullFileRewriteTarget("make 2>&1")).toBeUndefined();
    expect(bashFullFileRewriteTarget("git commit -m x")).toBeUndefined(); // 'committee'-style substring n/a
    expect(bashFullFileRewriteTarget("echo hi | tee.sh foo")).toBeUndefined(); // not the tee command
    expect(bashFullFileRewriteTarget("grep foo bar.py")).toBeUndefined();
    expect(bashFullFileRewriteTarget("pytest -q")).toBeUndefined();
  });

  it("returns promptly on a long digit run (QC: no ReDoS — narrowed regex has no unbounded \\d*)", () => {
    expect(bashFullFileRewriteTarget("echo " + "9".repeat(100000))).toBeUndefined();
  });
});

describe("LoopDetector — bash full-file rewrites count as edits (Epic 1.13, blind spot #1)", () => {
  it("trips file-edits after N heredoc rewrites of the same file (previously invisible)", () => {
    const d = new LoopDetector({ maxFileEdits: 3 });
    // distinct heredoc bodies -> the n-gram signal can't fire; isolate the per-file signal.
    expect(
      d.record({ name: "bash", args: { command: "cat <<EOF > g.py\n1\nEOF" } }),
    ).toBeUndefined();
    expect(
      d.record({ name: "bash", args: { command: "cat <<EOF > g.py\n2\nEOF" } }),
    ).toBeUndefined();
    expect(d.record({ name: "bash", args: { command: "cat <<EOF > g.py\n3\nEOF" } })).toEqual({
      signal: "file-edits",
      detail: "g.py",
      advisory: true,
    });
  });

  it("heredoc rewrites and edit-tool edits to the same path SHARE one counter (total churn)", () => {
    const d = new LoopDetector({ maxFileEdits: 3 });
    expect(
      d.record({ name: "edit", args: { path: "g.py", oldString: "a", newString: "b" } }),
    ).toBeUndefined();
    expect(
      d.record({ name: "bash", args: { command: "cat <<EOF > g.py\ny\nEOF" } }),
    ).toBeUndefined();
    // third rewrite of g.py across tools -> trips.
    expect(d.record({ name: "bash", args: { command: "cat <<EOF > g.py\nz\nEOF" } })).toEqual({
      signal: "file-edits",
      detail: "g.py",
      advisory: true,
    });
  });

  it("a non-writing or plain-redirect bash call never counts toward the per-file signal", () => {
    const d = new LoopDetector({ maxFileEdits: 2 });
    expect(d.record({ name: "bash", args: { command: "pytest -q" } })).toBeUndefined();
    expect(d.record({ name: "bash", args: { command: "echo x >> log" } })).toBeUndefined(); // append
    expect(d.record({ name: "bash", args: { command: "make > out.js" } })).toBeUndefined(); // build output
    expect(d.record({ name: "bash", args: { command: "cat g.py" } })).toBeUndefined();
  });

  it("heredoc rewrites of DIFFERENT files stay separate (does not over-trip)", () => {
    const d = new LoopDetector({ maxFileEdits: 2 });
    expect(
      d.record({ name: "bash", args: { command: "cat <<EOF > a.py\n1\nEOF" } }),
    ).toBeUndefined();
    expect(
      d.record({ name: "bash", args: { command: "cat <<EOF > b.py\n1\nEOF" } }),
    ).toBeUndefined();
    expect(d.record({ name: "bash", args: { command: "cat <<EOF > a.py\n2\nEOF" } })).toEqual({
      signal: "file-edits",
      detail: "a.py",
      advisory: true,
    });
  });

  it("the bash-rewrite signal can be disabled (bashTool: '')", () => {
    const d = new LoopDetector({ maxFileEdits: 2, bashTool: "" });
    expect(
      d.record({ name: "bash", args: { command: "cat <<EOF > a.py\n1\nEOF" } }),
    ).toBeUndefined();
    expect(
      d.record({ name: "bash", args: { command: "cat <<EOF > a.py\n2\nEOF" } }),
    ).toBeUndefined();
  });
});

describe("fileFamily — churning-name normalization (Epic 1.13)", () => {
  it("collapses a trailing version/number; keeps distinct stems distinct", () => {
    expect(fileFamily("build_gates.py")).toBe("build_gates.py");
    expect(fileFamily("build_gates2.py")).toBe("build_gates.py");
    expect(fileFamily("build_gates_v3.py")).toBe("build_gates.py");
    expect(fileFamily("dir/sub/build_gates10.py")).toBe("build_gates.py"); // basename-only
    expect(fileFamily("server.py")).toBe("server.py");
    expect(fileFamily("client.py")).toBe("client.py");
    expect(fileFamily("2048.py")).toBe("2048.py"); // all-digit stem kept (no empty family)
    expect(fileFamily("Makefile")).toBe("Makefile"); // no extension
    expect(fileFamily("dir/")).toBe("dir/"); // trailing slash → never collapse distinct dirs to ""
    expect(fileFamily("a/b/")).toBe("a/b/");
  });
});

describe("LoopDetector — over-generation guard (Epic 1.13, output side / blind spot #2)", () => {
  const bigBody = "x".repeat(5000); // makes the command ≥ 4096B (default largeRewriteBytes)
  const big = (file: string) => ({
    name: "bash",
    args: { command: `cat <<EOF > ${file}\n${bigBody}\nEOF` },
  });

  it("trips on churning-NAME re-emission of one logical file (the per-PATH counter misses this)", () => {
    // The measured circuit-fibsqrt mode: full-file `cat <<EOF` rewrites under churning names
    // (build_gates.py → build_gates2.py → …). Distinct paths → the per-file counter sees only 1 each;
    // the family counter collapses them (same family `build_gates.py`) and trips.
    const d = new LoopDetector({ maxLargeRewrites: 4 });
    expect(d.record(big("build_gates.py"))).toBeUndefined();
    expect(d.record(big("build_gates2.py"))).toBeUndefined();
    expect(d.record(big("build_gates3.py"))).toBeUndefined();
    expect(d.record(big("build_gates4.py"))).toEqual({
      signal: "file-edits",
      detail: "over-generation: 4 large rewrites of family build_gates.py",
      advisory: true,
    });
  });

  it("ADVERSARIAL: a legitimate multi-file workflow (DISTINCT large files) is PROVABLY never killed", () => {
    // The must-fix class: writing many distinct large files (real scaffolding/codegen) must not halt.
    // Each distinct name → distinct family → no family ever accumulates, at the DEFAULT threshold.
    const d = new LoopDetector(); // defaults (maxLargeRewrites 6)
    const files = [
      "server.py",
      "client.py",
      "models.py",
      "utils.py",
      "config.py",
      "routes.py",
      "auth.py",
      "db.py",
      "cache.py",
      "queue.py",
      "worker.py",
      "main.py", // 12 distinct large files
    ];
    for (const f of files) expect(d.record(big(f))).toBeUndefined(); // none trips — distinct families
  });

  it("does NOT count SMALL rewrites (a small generated file is not over-generation)", () => {
    const d = new LoopDetector({ maxLargeRewrites: 3 });
    // tiny heredoc bodies → command < 4096B → not counted, even re-emitting the same family.
    for (let i = 0; i < 10; i++)
      expect(
        d.record({ name: "bash", args: { command: `cat <<EOF > f${String(i)}.py\nsmall\nEOF` } }),
      ).toBeUndefined();
  });

  it("maxLargeRewrites: 0 disables the guard", () => {
    const d = new LoopDetector({ maxLargeRewrites: 0 });
    for (let i = 0; i < 20; i++) expect(d.record(big(`f${String(i)}.py`))).toBeUndefined();
  });

  it("reset() clears the family counts (a warning is a genuine second chance)", () => {
    const d = new LoopDetector({ maxLargeRewrites: 3 });
    d.record(big("g.py")); // family g.py: 1
    d.record(big("g2.py")); // family g.py: 2
    d.reset();
    expect(d.record(big("g3.py"))).toBeUndefined(); // family g.py back to 1
    expect(d.record(big("g4.py"))).toBeUndefined(); // 2 — not yet 3
  });
});

describe("LoopDetector — over-generation via the typed `write` tool (Epic 1.13 write side)", () => {
  const bigContent = "x".repeat(5000); // ≥ 4096B default
  const bigWrite = (path: string) => ({ name: "write", args: { path, content: bigContent } });

  it("counts a LARGE write content toward the SAME family-keyed over-generation guard", () => {
    // Churning-name re-emission through `write` (not bash) — same family `m.py`, trips at the threshold.
    const d = new LoopDetector({ maxLargeRewrites: 3 });
    expect(d.record(bigWrite("m.py"))).toBeUndefined();
    expect(d.record(bigWrite("m2.py"))).toBeUndefined();
    expect(d.record(bigWrite("m3.py"))).toEqual({
      signal: "file-edits",
      detail: "over-generation: 3 large rewrites of family m.py",
      advisory: true,
    });
  });

  it("mixes large bash heredocs and large writes of the same family in one counter", () => {
    const d = new LoopDetector({ maxLargeRewrites: 3 });
    expect(d.record(bigWrite("k.py"))).toBeUndefined(); // write, family k.py: 1
    expect(
      d.record({ name: "bash", args: { command: `cat <<EOF > k2.py\n${bigContent}\nEOF` } }),
    ).toBeUndefined(); // bash, family k.py: 2
    expect(d.record(bigWrite("k3.py"))).toEqual({
      signal: "file-edits",
      detail: "over-generation: 3 large rewrites of family k.py",
      advisory: true,
    });
  });

  it("ADVERSARIAL: distinct large `write`s (a legit codegen workflow) are PROVABLY never killed", () => {
    const d = new LoopDetector(); // default maxLargeRewrites 6
    for (const f of ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py", "g.py", "h.py"])
      expect(d.record(bigWrite(f))).toBeUndefined(); // distinct families → never accumulate
  });

  it("a large EDIT (targeted oldString/newString) never counts — only a full write content does", () => {
    const d = new LoopDetector({ maxLargeRewrites: 2 });
    for (let i = 0; i < 10; i++)
      expect(
        d.record({
          name: "edit",
          args: {
            path: `f${String(i)}.py`,
            oldString: "a".repeat(5000),
            newString: "b".repeat(5000),
          },
        }),
      ).toBeUndefined();
  });

  it("a SMALL write content does not count", () => {
    const d = new LoopDetector({ maxLargeRewrites: 2 });
    for (let i = 0; i < 10; i++)
      expect(
        d.record({ name: "write", args: { path: `f${String(i)}.py`, content: "small" } }),
      ).toBeUndefined();
  });

  it("contentArg: '' disables the write-content source (bash still works)", () => {
    const d = new LoopDetector({ maxLargeRewrites: 2, contentArg: "" });
    expect(d.record(bigWrite("m.py"))).toBeUndefined();
    expect(d.record(bigWrite("m2.py"))).toBeUndefined(); // would trip at 2 if counted — it isn't
  });
});
