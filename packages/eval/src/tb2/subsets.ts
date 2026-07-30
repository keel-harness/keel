import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The committed Terminal-Bench 2.1 catalog snapshot + the keel subset/smoke/held-out task lists
 * (Appendix F, Epic 1.11 QR-6). The catalog is PINNED (the **TB-2.1** dataset
 * `terminal-bench/terminal-bench-2-1` @ a fixed commit, Apache-2.0 — ADR-0042) so the integrity checks
 * are hermetic — they never hit the network. The three lists resolve the QR-6 held-out tension:
 *   - **keel-tb2-25** — the TUNED subset the §2.3 loop tunes on (25 stratified tasks);
 *   - **keel-tb2-5**  — the SMOKE set (5 fast tasks, a SUBSET of the tuned 25 — cheap liveness only);
 *   - **keel-tb2-heldout** — a held-out GENERALIZATION set, DISJOINT from the tuned 25 (overfit guard).
 *   - **keel-tb2-full-89** — the canonical FULL TB-2.1 suite manifest for claim-grade full-suite results.
 *
 * `assertSubsetIntegrity` is the fail-closed invariant the runner calls before spending: a malformed,
 * out-of-catalog, or overlapping list refuses the run rather than scoring against a broken subset.
 */

const Difficulty = z.enum(["easy", "medium", "hard"]);

/** One task's pinned catalog metadata (from its `task.toml`). */
export const CatalogTask = z
  .object({
    id: z.string().min(1),
    difficulty: Difficulty,
    category: z.string().min(1),
    tags: z.array(z.string()),
  })
  .strict();
export type CatalogTaskT = z.infer<typeof CatalogTask>;

/** The pinned TB-2.1 catalog snapshot (the integrity-test source of truth). */
export const Tb2Catalog = z
  .object({
    $comment: z.string().optional(),
    suite: z.literal("terminal-bench-2"),
    version: z.string().min(1),
    pin: z
      .object({
        harborDataset: z.string().min(1),
        registry: z.string().min(1),
        taskRepo: z.string().min(1),
        taskRepoCommit: z.string().min(1),
        license: z.string().min(1),
      })
      .strict(),
    taskCount: z.number().int().positive(),
    tasks: z.array(CatalogTask),
  })
  .strict();
export type Tb2CatalogT = z.infer<typeof Tb2Catalog>;

/** A committed keel task list (subset / smoke / held-out): names + the task ids, nothing executable. */
export const Tb2TaskList = z
  .object({
    $comment: z.string().optional(),
    name: z.string().min(1),
    suite: z.literal("terminal-bench-2"),
    version: z.string().min(1),
    taskCount: z.number().int().nonnegative(),
    tasks: z.array(z.string().min(1)),
  })
  .strict();
export type Tb2TaskListT = z.infer<typeof Tb2TaskList>;

export const KEEL_TB2_TUNED = "keel-tb2-25";
export const KEEL_TB2_SMOKE = "keel-tb2-5";
export const KEEL_TB2_HELDOUT = "keel-tb2-heldout";
export const KEEL_TB2_FULL_89 = "keel-tb2-full-89";

/**
 * Pinned task counts per subset (ADR-0042). These are the SAME numbers the committed lists carry in
 * their `taskCount` — kept here as pure constants so callers that must bind a run/score to its claimed
 * subset (the runner pre-flight and the scoreboard refine) can do so WITHOUT file I/O, and a drift test
 * asserts they match the committed lists. A subset name absent here is a custom/ad-hoc set with no
 * pinned size to bind to. (EVAL-1/EVAL-2.)
 */
export const SUBSET_TASK_COUNTS: Readonly<Record<string, number>> = {
  [KEEL_TB2_TUNED]: 25,
  [KEEL_TB2_SMOKE]: 5,
  [KEEL_TB2_HELDOUT]: 10,
  [KEEL_TB2_FULL_89]: 89,
};

/** Raised when a committed task list violates an integrity invariant (fail closed — never run a
 *  benchmark against a malformed/out-of-catalog/overlapping subset). */
export class SubsetIntegrityError extends Error {
  constructor(message: string) {
    super(`tb2 subset: ${message}`);
    this.name = "SubsetIntegrityError";
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`./${file}`, import.meta.url), "utf8")) as unknown;
}

/** Load + validate the pinned catalog snapshot. */
export function loadCatalog(): Tb2CatalogT {
  return Tb2Catalog.parse(readJson("catalog.json"));
}

/** Load + validate one committed task list by name (`keel-tb2-25` / `keel-tb2-5` / `keel-tb2-heldout`). */
export function loadTaskList(name: string): Tb2TaskListT {
  return Tb2TaskList.parse(readJson(`${name}.json`));
}

/** A list's `tasks` must be unique, match its `taskCount`, and every id must exist in the catalog. */
function checkList(list: Tb2TaskListT, catalogIds: ReadonlySet<string>): void {
  const set = new Set(list.tasks);
  if (set.size !== list.tasks.length) {
    throw new SubsetIntegrityError(`${list.name} contains duplicate task ids`);
  }
  if (list.taskCount !== list.tasks.length) {
    throw new SubsetIntegrityError(
      `${list.name} taskCount ${list.taskCount} != ${list.tasks.length} ids`,
    );
  }
  for (const id of list.tasks) {
    if (!catalogIds.has(id)) {
      throw new SubsetIntegrityError(
        `${list.name} references "${id}", absent from the pinned TB-2.1 catalog`,
      );
    }
  }
}

/**
 * Pure fail-closed integrity check over an already-loaded catalog + the three lists. Throws
 * `SubsetIntegrityError` on any violation. Pure (no I/O) so the violation paths are unit-testable with
 * crafted inputs. Invariants:
 *   - catalog: unique ids, `taskCount` matches;
 *   - every list: unique ids that all exist in the catalog, `taskCount` matches;
 *   - smoke ⊆ tuned (the smoke set is a cheap subset of the tuned set);
 *   - held-out ∩ tuned = ∅ (held-out is disjoint — the overfit guard).
 */
export function checkSubsetIntegrity(
  catalog: Tb2CatalogT,
  tuned: Tb2TaskListT,
  smoke: Tb2TaskListT,
  heldout: Tb2TaskListT,
): void {
  const catalogIds = catalog.tasks.map((t) => t.id);
  if (new Set(catalogIds).size !== catalogIds.length) {
    throw new SubsetIntegrityError("catalog contains duplicate task ids");
  }
  if (catalog.taskCount !== catalogIds.length) {
    throw new SubsetIntegrityError(
      `catalog taskCount ${catalog.taskCount} != ${catalogIds.length} tasks`,
    );
  }
  const idSet = new Set(catalogIds);
  for (const list of [tuned, smoke, heldout]) checkList(list, idSet);

  const tunedSet = new Set(tuned.tasks);
  for (const id of smoke.tasks) {
    if (!tunedSet.has(id)) {
      throw new SubsetIntegrityError(`smoke task "${id}" is not a subset of ${KEEL_TB2_TUNED}`);
    }
  }
  for (const id of heldout.tasks) {
    if (tunedSet.has(id)) {
      throw new SubsetIntegrityError(
        `held-out task "${id}" also appears in ${KEEL_TB2_TUNED} (must be disjoint — overfit guard)`,
      );
    }
  }
}

/**
 * Load the committed catalog + the three lists and run `checkSubsetIntegrity`. Throws on any
 * violation; returns the validated set on success. The runner calls this before spending so a
 * malformed/out-of-catalog/overlapping subset refuses the run rather than scoring against a broken set.
 */
export function assertSubsetIntegrity(): {
  catalog: Tb2CatalogT;
  tuned: Tb2TaskListT;
  smoke: Tb2TaskListT;
  heldout: Tb2TaskListT;
  full: Tb2TaskListT;
} {
  const catalog = loadCatalog();
  const tuned = loadTaskList(KEEL_TB2_TUNED);
  const smoke = loadTaskList(KEEL_TB2_SMOKE);
  const heldout = loadTaskList(KEEL_TB2_HELDOUT);
  const full = loadTaskList(KEEL_TB2_FULL_89);
  checkSubsetIntegrity(catalog, tuned, smoke, heldout);
  checkFullSuiteList(catalog, full);
  return { catalog, tuned, smoke, heldout, full };
}

function sameMembership(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function checkFullSuiteList(catalog: Tb2CatalogT, full: Tb2TaskListT): void {
  const catalogIds = new Set(catalog.tasks.map((t) => t.id));
  checkList(full, catalogIds);
  const fullIds = new Set(full.tasks);
  if (!sameMembership(fullIds, catalogIds)) {
    throw new SubsetIntegrityError(
      `${KEEL_TB2_FULL_89} must exactly match the pinned TB-2.1 catalog`,
    );
  }
}

/**
 * Bind a run's task set to the subset it CLAIMS to be, fail-closed, before any paid call (EVAL-1).
 * For a known pinned subset name the ids must be EXACTLY its committed task set (same membership and
 * count); a custom/unknown subset name is allowed (there is no pinned list to bind to). This is the
 * run-boundary counterpart to the scoreboard's record-time refine: together they ensure "what we claim
 * we ran" (the subset label) and "what we actually run/score" (the ids) cannot silently diverge — e.g.
 * a 3-of-25 run can never be dispatched or recorded as `keel-tb2-25`.
 */
export function assertRunMatchesSubset(subsetName: string, taskIds: readonly string[]): void {
  const given = new Set(taskIds);
  if (given.size !== taskIds.length) {
    throw new SubsetIntegrityError(
      `run labeled ${subsetName} contains duplicate task ids — refusing to run/score an ambiguous task set`,
    );
  }
  if (!(subsetName in SUBSET_TASK_COUNTS)) {
    const full = new Set(loadTaskList(KEEL_TB2_FULL_89).tasks);
    if (sameMembership(given, full)) {
      throw new SubsetIntegrityError(
        `run uses the full 89-task suite but is labeled ${subsetName}; use canonical subset ${KEEL_TB2_FULL_89}`,
      );
    }
    return; // custom subset — nothing pinned to bind to
  }
  const pinned = new Set(loadTaskList(subsetName).tasks);
  const missing = [...pinned].filter((id) => !given.has(id));
  const extra = [...given].filter((id) => !pinned.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new SubsetIntegrityError(
      `run labeled ${subsetName} does not match its pinned ${String(pinned.size)}-task set ` +
        `(given ${String(given.size)} unique id(s); ${String(missing.length)} missing, ` +
        `${String(extra.length)} unexpected) — refusing to run/score a mismatched set as ${subsetName}`,
    );
  }
}
