import { describe, expect, it } from "vitest";
import {
  KEEL_TB2_FULL_89,
  KEEL_TB2_HELDOUT,
  KEEL_TB2_SMOKE,
  KEEL_TB2_TUNED,
  SUBSET_TASK_COUNTS,
  SubsetIntegrityError,
  type Tb2CatalogT,
  type Tb2TaskListT,
  assertRunMatchesSubset,
  assertSubsetIntegrity,
  checkSubsetIntegrity,
  loadCatalog,
  loadTaskList,
} from "./subsets.js";

describe("SUBSET_TASK_COUNTS + assertRunMatchesSubset (EVAL-1 — bind a run to its claimed subset)", () => {
  it("SUBSET_TASK_COUNTS matches each committed list's pinned taskCount (no drift)", () => {
    for (const name of [KEEL_TB2_TUNED, KEEL_TB2_SMOKE, KEEL_TB2_HELDOUT, KEEL_TB2_FULL_89]) {
      expect(SUBSET_TASK_COUNTS[name]).toBe(loadTaskList(name).taskCount);
    }
  });

  it("the full-89 manifest exactly matches the pinned TB-2.1 catalog", () => {
    const catalog = loadCatalog();
    const full = loadTaskList(KEEL_TB2_FULL_89);
    expect(full.taskCount).toBe(89);
    expect(full.tasks).toHaveLength(89);
    expect(new Set(full.tasks).size).toBe(89);
    expect(new Set(full.tasks)).toEqual(new Set(catalog.tasks.map((t) => t.id)));
  });

  it("accepts the exact pinned task set for a known subset", () => {
    const tuned = loadTaskList(KEEL_TB2_TUNED);
    expect(() => assertRunMatchesSubset(KEEL_TB2_TUNED, tuned.tasks)).not.toThrow();
    const full = loadTaskList(KEEL_TB2_FULL_89);
    expect(() => assertRunMatchesSubset(KEEL_TB2_FULL_89, full.tasks)).not.toThrow();
  });

  it("refuses a partial / superset / wrong-membership run labeled as a pinned subset (fail closed)", () => {
    const tuned = loadTaskList(KEEL_TB2_TUNED);
    // partial — fewer ids than the pinned set (the "3 of 25 reads as 25" hazard, at the run boundary)
    expect(() => assertRunMatchesSubset(KEEL_TB2_TUNED, tuned.tasks.slice(0, 3))).toThrow(
      SubsetIntegrityError,
    );
    // superset — an extra id smuggled in
    expect(() => assertRunMatchesSubset(KEEL_TB2_TUNED, [...tuned.tasks, "extra-task"])).toThrow(
      SubsetIntegrityError,
    );
    // same count, wrong membership — one pinned id swapped for a non-member
    expect(() =>
      assertRunMatchesSubset(KEEL_TB2_TUNED, [...tuned.tasks.slice(1), "not-in-subset"]),
    ).toThrow(SubsetIntegrityError);
  });

  it("refuses duplicate or renamed-custom attempts to record the full-89 task set", () => {
    const full = loadTaskList(KEEL_TB2_FULL_89);
    expect(() => assertRunMatchesSubset(KEEL_TB2_FULL_89, [full.tasks[0]!, ...full.tasks])).toThrow(
      SubsetIntegrityError,
    );
    expect(() => assertRunMatchesSubset("adhoc-renamed-full-89", full.tasks)).toThrow(
      SubsetIntegrityError,
    );
  });

  it("allows a custom (non-pinned) subset name — nothing pinned to bind to", () => {
    expect(() => assertRunMatchesSubset("adhoc-debug", ["whatever"])).not.toThrow();
  });
});

// Integrity tests for the committed TB-2.1 catalog snapshot + the three keel task lists (QR-6).
// Hermetic: everything is read from the committed JSON (no network).

describe("TB-2.1 catalog snapshot (pinned)", () => {
  it("loads, has 89 unique tasks, and records the pin coordinates", () => {
    const catalog = loadCatalog();
    expect(catalog.suite).toBe("terminal-bench-2");
    expect(catalog.version).toBe("2.1");
    expect(catalog.taskCount).toBe(89);
    expect(catalog.tasks).toHaveLength(89);
    expect(new Set(catalog.tasks.map((t) => t.id)).size).toBe(89);
    // The durable pin: the TB-2.1 task-repo commit (byte-reproducibility) + the dataset id.
    expect(catalog.pin.taskRepoCommit).toBe("c5ee500c185224c97cd6caff7866a990a0057f41");
    expect(catalog.pin.harborDataset).toBe("terminal-bench/terminal-bench-2-1");
    expect(catalog.pin.license).toBe("Apache-2.0");
  });

  it("every task carries stratification metadata (difficulty + category)", () => {
    for (const t of loadCatalog().tasks) {
      expect(["easy", "medium", "hard"]).toContain(t.difficulty);
      expect(t.category.length).toBeGreaterThan(0);
    }
  });
});

describe("keel task lists — sizes + names", () => {
  it("keel-tb2-25 has 25 tasks", () => {
    expect(loadTaskList(KEEL_TB2_TUNED).tasks).toHaveLength(25);
  });
  it("keel-tb2-5 has 5 tasks", () => {
    expect(loadTaskList(KEEL_TB2_SMOKE).tasks).toHaveLength(5);
  });
  it("keel-tb2-heldout has 10 tasks", () => {
    expect(loadTaskList(KEEL_TB2_HELDOUT).tasks).toHaveLength(10);
  });
});

describe("subset integrity (the fail-closed invariant)", () => {
  it("passes: all ids exist in the catalog, smoke ⊆ tuned, held-out ∩ tuned = ∅", () => {
    const { tuned, smoke, heldout } = assertSubsetIntegrity();
    const tunedSet = new Set(tuned.tasks);
    // smoke ⊆ tuned
    for (const id of smoke.tasks) expect(tunedSet.has(id)).toBe(true);
    // held-out disjoint from tuned (the overfit guard)
    for (const id of heldout.tasks) expect(tunedSet.has(id)).toBe(false);
  });

  it("the tuned 25 is stratified — spans many categories and ≥2 difficulties", () => {
    const { catalog, tuned } = assertSubsetIntegrity();
    const meta = new Map(catalog.tasks.map((t) => [t.id, t]));
    const cats = new Set(tuned.tasks.map((id) => meta.get(id)?.category));
    const diffs = new Set(tuned.tasks.map((id) => meta.get(id)?.difficulty));
    // Representative breadth: the suite has 16 categories — the tuned subset covers all of them.
    expect(cats.size).toBe(16);
    expect(diffs.size).toBeGreaterThanOrEqual(2);
  });

  it("the held-out set is also stratified (disjoint generalization probe)", () => {
    const { catalog, heldout } = assertSubsetIntegrity();
    const meta = new Map(catalog.tasks.map((t) => [t.id, t]));
    const cats = new Set(heldout.tasks.map((id) => meta.get(id)?.category));
    expect(cats.size).toBeGreaterThanOrEqual(5);
  });
});

describe("checkSubsetIntegrity — fail-closed on every violation (crafted inputs)", () => {
  // A small valid baseline; each case perturbs exactly one invariant.
  const cat = (ids: string[]): Tb2CatalogT => ({
    suite: "terminal-bench-2",
    version: "2.1",
    pin: {
      harborDataset: "terminal-bench/terminal-bench-2-1",
      registry: "r",
      taskRepo: "u",
      taskRepoCommit: "c",
      license: "Apache-2.0",
    },
    taskCount: ids.length,
    tasks: ids.map((id) => ({ id, difficulty: "medium" as const, category: "x", tags: [] })),
  });
  const list = (name: string, tasks: string[]): Tb2TaskListT => ({
    name,
    suite: "terminal-bench-2",
    version: "2.1",
    taskCount: tasks.length,
    tasks,
  });
  const C = cat(["a", "b", "c", "d"]);
  const TUNED = list(KEEL_TB2_TUNED, ["a", "b", "c"]);
  const SMOKE = list(KEEL_TB2_SMOKE, ["a"]);
  const HELD = list(KEEL_TB2_HELDOUT, ["d"]);

  it("accepts a valid set", () => {
    expect(() => checkSubsetIntegrity(C, TUNED, SMOKE, HELD)).not.toThrow();
  });

  it("rejects a catalog with duplicate ids", () => {
    const dup = { ...cat(["a", "a"]), taskCount: 2 };
    expect(() =>
      checkSubsetIntegrity(dup, list(KEEL_TB2_TUNED, ["a"]), SMOKE, list(KEEL_TB2_HELDOUT, [])),
    ).toThrow(SubsetIntegrityError);
  });

  it("rejects a catalog whose taskCount disagrees with its tasks", () => {
    expect(() => checkSubsetIntegrity({ ...C, taskCount: 99 }, TUNED, SMOKE, HELD)).toThrow(
      /taskCount/,
    );
  });

  it("rejects a list with duplicate ids", () => {
    expect(() =>
      checkSubsetIntegrity(C, list(KEEL_TB2_TUNED, ["a", "a", "b"]), SMOKE, HELD),
    ).toThrow(/duplicate/);
  });

  it("rejects a list whose taskCount disagrees with its ids", () => {
    const bad: Tb2TaskListT = { ...TUNED, taskCount: 99 };
    expect(() => checkSubsetIntegrity(C, bad, SMOKE, HELD)).toThrow(/taskCount/);
  });

  it("rejects a task id absent from the catalog", () => {
    expect(() => checkSubsetIntegrity(C, list(KEEL_TB2_TUNED, ["a", "zzz"]), SMOKE, HELD)).toThrow(
      /absent from the pinned TB-2\.1 catalog/,
    );
  });

  it("rejects a smoke task not in the tuned set", () => {
    expect(() => checkSubsetIntegrity(C, TUNED, list(KEEL_TB2_SMOKE, ["d"]), HELD)).toThrow(
      /not a subset/,
    );
  });

  it("rejects a held-out task that overlaps the tuned set (overfit guard)", () => {
    expect(() => checkSubsetIntegrity(C, TUNED, SMOKE, list(KEEL_TB2_HELDOUT, ["a"]))).toThrow(
      /must be disjoint/,
    );
  });
});
