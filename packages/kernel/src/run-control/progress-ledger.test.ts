import { describe, expect, it } from "vitest";
import {
  ProgressLedger,
  classifyBashCommand,
  progressEvidenceForToolResult,
} from "./progress-ledger.js";

describe("progress-ledger command classification", () => {
  it("classifies common shell intent without task-name rules", () => {
    expect(classifyBashCommand("pytest -q")).toBe("verifier");
    expect(classifyBashCommand("pnpm typecheck")).toBe("verifier");
    expect(classifyBashCommand("make -j2 world")).toBe("build");
    expect(classifyBashCommand("john --show hash.txt")).toBe("poll");
    expect(classifyBashCommand("curl -fsS http://127.0.0.1:8000/health")).toBe("poll");
    expect(classifyBashCommand("curl -X DELETE http://127.0.0.1:8000/status")).toBe("mutator");
    expect(classifyBashCommand("kill -9 1234; ps aux")).toBe("destructive");
    expect(classifyBashCommand("tail -n 20 -f server.log")).toBe("poll");
    expect(classifyBashCommand("head server.log")).toBe("unknown");
    expect(classifyBashCommand("tail -n 20 server.log")).toBe("unknown");
    expect(classifyBashCommand("service postfix reload")).toBe("idempotent");
    expect(classifyBashCommand("service postfix restart")).toBe("unknown");
    expect(classifyBashCommand("systemctl start postgres")).toBe("unknown");
    expect(classifyBashCommand("pip install -r requirements.txt")).toBe("mutator");
    expect(classifyBashCommand("rm -rf /tmp/build")).toBe("destructive");
    expect(classifyBashCommand("python solve.py")).toBe("unknown");
  });

  it("classifies direct Node test entrypoints without laundering arbitrary or compound scripts", () => {
    expect(classifyBashCommand("node test.mjs")).toBe("verifier");
    expect(classifyBashCommand("node ./tests.cjs")).toBe("verifier");
    expect(classifyBashCommand("node --test")).toBe("verifier");
    expect(classifyBashCommand("node app.mjs")).toBe("unknown");
    expect(classifyBashCommand("node goal-check.mjs")).toBe("unknown");
    expect(classifyBashCommand("node test.mjs && printf done")).toBe("unknown");
    expect(classifyBashCommand("node test.mjs $(printf done)")).toBe("unknown");
    expect(classifyBashCommand("node test.mjs `printf done`")).toBe("unknown");
    expect(classifyBashCommand("node test.mjs\nprintf done")).toBe("unknown");
    expect(classifyBashCommand("node test.mjs && rm -rf fixture")).toBe("destructive");
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "node goal-check.mjs" } },
        JSON.stringify({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
        { ok: true },
      ),
    ).toMatchObject({ commandClass: "unknown", benignRepeat: false });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "node goal-check.mjs" } },
        JSON.stringify({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
        { ok: true },
      ).successSignal,
    ).toBeUndefined();
  });

  it("extracts verifier and build success signals from existing bash output", () => {
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "pytest -q" } },
        "(command produced no output; exit code 0)\n",
      ),
    ).toMatchObject({ commandClass: "verifier", successSignal: "silent_success" });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "pytest -q" } },
        "TEST SUMMARY (pytest): PASS - 12 passed\n",
      ),
    ).toMatchObject({ commandClass: "verifier", successSignal: "test_passed" });
    expect(
      progressEvidenceForToolResult({ name: "bash", args: { command: "pytest -q" } }, "0 failed\n"),
    ).toMatchObject({ commandClass: "verifier", successSignal: "test_passed" });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "pytest -q" } },
        "no failures\n",
      ),
    ).toMatchObject({ commandClass: "verifier", successSignal: "test_passed" });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "make -j2" } },
        "Finished release profile\n",
      ),
    ).toMatchObject({ commandClass: "build", successSignal: "build_passed" });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "node test.mjs" } },
        "K310-TEST-PASS\n",
        { ok: true },
      ),
    ).toMatchObject({ commandClass: "verifier", successSignal: "test_passed" });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "python optimize.py" } },
        "loss: 0.42\n",
        { metricDelta: 0.1 },
      ),
    ).toMatchObject({ commandClass: "unknown", successSignal: "metric_improved" });
  });

  it("marks poll and idempotent successful output as benign but not authoritative success", () => {
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "john --show hash.txt" } },
        "0 password hashes cracked, 1 left\n",
      ),
    ).toMatchObject({ commandClass: "poll", benignRepeat: true });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "service postfix reload" } },
        "refreshing the postfix mail system\n",
      ),
    ).toMatchObject({ commandClass: "idempotent", benignRepeat: true });
  });

  it("does not launder failed output into progress evidence", () => {
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "pytest -q" } },
        "Traceback (most recent call last):\nAssertionError: unchanged failure\n",
      ),
    ).toMatchObject({ commandClass: "verifier", benignRepeat: false });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "service postfix reload" } },
        "reload failed\n[exit code: 1]\n",
      ),
    ).toMatchObject({ commandClass: "idempotent", benignRepeat: false });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "service postfix reload" } },
        "reload failed\n",
      ),
    ).toMatchObject({ commandClass: "idempotent", benignRepeat: false });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "pytest -q" } },
        "8 passed, 1 failed\n",
      ),
    ).toMatchObject({ commandClass: "verifier", benignRepeat: false });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "pytest -q" } },
        "0 failed, 1 error\n",
      ),
    ).toMatchObject({ commandClass: "verifier", benignRepeat: false });
    expect(
      progressEvidenceForToolResult(
        { name: "bash", args: { command: "john --show hash.txt" } },
        "0 password hashes cracked, 1 left\n",
        { ok: false },
      ),
    ).toMatchObject({ commandClass: "poll", benignRepeat: false });
  });

  it("records bounded per-step progress ledger fields without claiming unknown novelty", () => {
    const ledger = new ProgressLedger();

    const entry = ledger.record(
      { name: "bash", args: { command: "pytest -q" } },
      "TEST SUMMARY (pytest): PASS - 12 passed\n",
      { ok: true, durationMs: 250 },
    );

    expect(entry).toMatchObject({
      commandClass: "verifier",
      durationMs: 250,
      exitCode: 0,
      successSignal: "test_passed",
      benignRepeat: false,
      workspaceNovelty: "unknown",
      processNovelty: "unknown",
    });
    expect(entry.actionSignature).toMatch(/^bash:[0-9a-f]{8}$/);
    expect(entry.patternSignature).toContain("verifier:");
    expect(entry.stdoutHash).toMatch(/^[0-9a-f]{8}$/);
    expect(ledger.entries()).toEqual([entry]);
  });

  it("bounds retained ledger entries and stores hashed action signatures", () => {
    const ledger = new ProgressLedger(2);
    const largeCommand = `cat <<EOF > out.txt\n${"x".repeat(10_000)}\nEOF`;

    ledger.record({ name: "bash", args: { command: largeCommand } }, "wrote out.txt\n");
    const second = ledger.record({ name: "bash", args: { command: "pytest -q" } }, "0 failed\n");
    const third = ledger.record({ name: "bash", args: { command: "make -j2" } }, "building\n");

    expect(ledger.entries()).toEqual([second, third]);
    expect(third.actionSignature).toMatch(/^bash:[0-9a-f]{8}$/);
    expect(JSON.stringify(ledger.entries())).not.toContain("x".repeat(128));
  });
});
