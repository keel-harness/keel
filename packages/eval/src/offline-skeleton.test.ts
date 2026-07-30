import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ModelMessageT,
  type ModelPort,
  type ModelStreamChunkT,
  Recording,
  type RecordingT,
} from "@keel/shared";
import { replayModelToTrajectory } from "./replay.js";
import { readTrajectory, writeTrajectory } from "./store.js";
import { parseTerminalBenchResults } from "./results.js";

/**
 * Epic 1.11 Phase-A walking skeleton (no spend). Proves the keel-side benchmark pipeline across the
 * real `@keel/eval` boundaries — the trajectory driver → the trajectory store → the Terminal-Bench
 * results parser — with ZERO model cost, before Phase B spends anything.
 *
 * The committed `Recording` (ADR-0031) is the SAME full-fidelity format that `keel run --replay`
 * consumes; a tiny in-test `ModelPort` replays its turns verbatim — the same behavior as the kernel's
 * `RecordedModelPort`, which the Epic 1.10 CI replay smoke already exercises end-to-end on the real
 * compiled binary. We deliberately do NOT import `@keel/kernel` here so the eval package stays
 * React/ink-free (its `tsc --noEmit` must not pull the kernel's Ink UI into scope); this test proves
 * the eval-side pipeline (Recording → trajectory → store → results parse) hermetically. The Python
 * adapter under `eval/harbor-adapter/` is what CONSTRUCTS the `keel run -p … --replay <rec>` command
 * (its own hermetic builder test); together they validate the wiring before any spend.
 */

/** A minimal `ModelPort` replaying a `Recording`'s turns in order — one turn per `stream()` call.
 *  (The kernel's `RecordedModelPort` is the production replayer; this is the trivial test stand-in so
 *  eval needn't depend on the React-coupled kernel package just to typecheck an import.) */
class RecordingReplayPort implements ModelPort {
  private turn = 0;
  constructor(private readonly recording: RecordingT) {}
  stream(): AsyncIterable<ModelStreamChunkT> {
    const chunks = this.recording.turns[this.turn]?.chunks ?? [];
    this.turn += 1;
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  }
}

const RECORDING_FILE = fileURLToPath(
  new URL("./fixtures/offline-skeleton.recording.json", import.meta.url),
);
const RESULTS = fileURLToPath(new URL("./fixtures/offline-skeleton.results.json", import.meta.url));

const SEED: readonly ModelMessageT[] = [
  { role: "user", content: "Fix the failing check in this repo." },
];

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "keel-skeleton-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("Epic 1.11 offline walking skeleton (no spend)", () => {
  it("drives a committed Recording end-to-end into a stored, reloadable trajectory", async () => {
    // Step 1: parse the committed Recording with the REAL frozen `@keel/shared` schema (ADR-0031), then
    // replay it through a ModelPort — no API key, no network, the same format `keel run --replay` uses.
    const recording = Recording.parse(JSON.parse(await readFile(RECORDING_FILE, "utf8")));
    const model = new RecordingReplayPort(recording);

    // Step 2: drive the recorded session into a `Trajectory` (the §2.3 iteration-loop substrate).
    const traj = await replayModelToTrajectory(model, SEED, {
      runId: "offline-skeleton-001",
      task: "hello-world",
      suite: "terminal-bench-2",
      model: "keel-offline-skeleton",
      startedAt: "2026-06-16T00:00:00.000Z",
    });

    // The trajectory captured the recorded run: the bash tool call + the terminal answer text, and a
    // clean (non-faulted) outcome. This proves the replay loop ran the whole session offline.
    expect(traj.outcome).toBe("resolved");
    const toolCalls = traj.events.filter((e) => e.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: "bash" });
    const finalText = traj.events
      .filter(
        (e): e is Extract<typeof e, { type: "assistant-text" }> => e.type === "assistant-text",
      )
      .map((e) => e.text)
      .join("");
    expect(finalText).toContain("offline-skeleton-complete");
    expect(traj.totals.toolCalls).toBe(1);
    // Usage flows through from the recording's `finish` chunks (the single source of truth).
    expect(traj.totals.inputTokens).toBe(288);
    expect(traj.totals.outputTokens).toBe(42);

    // Step 3: the trajectory store boundary — persist + reload identically (Epic 0.4 store).
    const file = await writeTrajectory(base, traj);
    expect(
      file.endsWith(join("terminal-bench-2", "offline-skeleton-001", "hello-world.json")),
    ).toBe(true);
    expect(await readTrajectory(file)).toEqual(traj);
  });

  it("parses the synthetic TB-2 grader results.json into a stable BenchmarkResult", async () => {
    // Step 4: the result-parse boundary — the TB-2 grader's own verdict (resolved/unresolved) is the
    // ground truth for the score; keel's exit code is NOT (QR-7). One resolved task → rate 1.0.
    const raw: unknown = JSON.parse(await readFile(RESULTS, "utf8"));
    const result = parseTerminalBenchResults(raw, "terminal-bench-2");
    expect(result.nTasks).toBe(1);
    expect(result.nResolved).toBe(1);
    expect(result.nUnresolved).toBe(0);
    expect(result.resolvedRate).toBe(1);
    expect(result.tasks[0]).toMatchObject({ taskId: "hello-world", resolved: true });
  });
});
