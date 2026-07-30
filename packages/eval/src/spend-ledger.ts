import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { IsoTimestamp, redactJsonValue } from "@keel/shared";
import { CostCapError, assertConfigCostCap, assertConfigMonthlyCap } from "./cost-cap.js";
import type { EvalConfigT } from "./config.js";

/**
 * The durable cross-run spend ledger (Epic 1.11 QR-1). The merged cost-cap guards (`cost-cap.ts`) are
 * pure and take `monthToDateUSD` — nothing accumulates it. This module is that accumulator: an
 * append-only JSONL of per-run ACTUAL costs, with UTC month-to-date aggregation read at run start to
 * feed `assertConfigMonthlyCap`, and `guardedRun` — the single spending chokepoint that refuses an
 * over-budget run BEFORE any paid call and records the actual cost after.
 *
 * **Money-safety invariants (why this is fail-closed):**
 *  - `guardedRun` holds an **exclusive ledger lock** across read-check-spend-record, so two concurrent
 *    runs (the owner runs parallel sessions sharing one ledger) cannot both read month-to-date before
 *    either records and thereby defeat the monthly cap — a second concurrent run REFUSES, never overspends.
 *  - The cap is checked on the **estimate** (a pre-run UPPER-BOUND ceiling — `estimateCostUSD`) BEFORE
 *    the spend; the ledger records the measured cost AFTER. `estimateCostUSD` is an *un-cached* ceiling
 *    (all input at the fresh rate), so it upper-bounds the discounted real bill on any cache-READ-heavy
 *    run — but a cache-WRITE-heavy run bills the write subset at the 1.25× premium (ADR-0047) and can
 *    exceed it. `guardedRun` therefore enforces the bound post-spend against **both** the UB `actualUSD`
 *    AND the accumulated `realCostUSD`: if either exceeds the estimate it halts loudly (recording the
 *    spend first) rather than silently authorising the next over-budget run (QC §9).
 *  - **Real-cost accounting (ADR-0048 Option A):** each record carries BOTH the conservative un-cached UB
 *    (`costUSD`) AND the REAL cache-discounted cost (`realCostUSD`); the monthly accumulator prefers the
 *    real figure (falling back to the UB for legacy records) so the MONTHLY cap is denominated in real
 *    dollars. The per-run pre-spend check rides the UB estimate; the post-spend backstop rides the
 *    higher of the UB `actualUSD` and the real `realCostUSD`, so a cache-write premium that pushes real
 *    above the estimate cannot silently authorise the next over-budget run (QC §9).
 *  - A corrupt/torn ledger line FAILS CLOSED (`SpendLedgerCorruptError`, with an actionable recovery
 *    hint) rather than being skipped — silently dropping a record would under-count month-to-date.
 *  - A missing ledger reads as empty ($0 month-to-date) — a fresh ledger is the legitimate start state.
 *  - Every write chokepoint here (and the trajectory + scoreboard stores) routes through the SEC-014
 *    `redactText` filter, so a credential in a free-text field never lands on disk.
 */

/** One recorded run's ACTUAL cost. Additive schema (no frozen contract); validated on every read. */
export const SpendRecord = z
  .object({
    runId: z.string().min(1),
    at: IsoTimestamp, // UTC ISO timestamp the run was recorded at
    // The conservative un-cached UPPER BOUND on this run's cost (`estimateCostUSD` / `measureBenchmarkCost`
    // charge every input token at the full fresh rate). KEPT as the safe ceiling the per-run pre-spend gate
    // rides; the post-spend backstop rides the higher of this and `realCostUSD` below (QC §9).
    costUSD: z.number().nonnegative().finite(),
    // ADDITIVE (ADR-0048 Option A): the REAL cache-discounted cost the API actually billed, recorded
    // ALONGSIDE `costUSD`. When present, the month-to-date accumulator PREFERS it so the MONTHLY cap is
    // denominated in real dollars; a legacy record without it falls back to `costUSD` (the conservative
    // UB), so the rollover never *under*-counts history. Bounds-checked like its sibling (nonnegative +
    // finite) — a corrupt real cost fails the schema closed rather than under-counting spend.
    realCostUSD: z.number().nonnegative().finite().optional(),
    suite: z.string().min(1),
    model: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();
export type SpendRecordT = z.infer<typeof SpendRecord>;

/** Default ledger location (relative to the eval working dir). The live ledger is gitignored runtime
 *  state; the schema + path are committed. Callers should pass an explicit absolute path in practice. */
export const DEFAULT_SPEND_LEDGER_PATH = "eval/spend-ledger.jsonl";

/** Raised when the ledger contains an unparseable or schema-invalid line. Fail-closed: a corrupt ledger
 *  must never be silently under-counted into authorising an over-budget run. */
export class SpendLedgerCorruptError extends Error {
  constructor(message: string) {
    super(`spend ledger: ${message}`);
    this.name = "SpendLedgerCorruptError";
  }
}

/**
 * Durably append one record as a single `\n`-terminated JSON line. Opens with `O_APPEND` (`a`) so the
 * write is atomic for a small record on a local filesystem, `fsync`s before returning so a recorded
 * spend survives a crash, and creates the parent directory if missing. The record is validated before
 * write so the ledger never persists a malformed line.
 */
export async function appendSpendRecord(ledgerPath: string, record: SpendRecordT): Promise<void> {
  const valid = SpendRecord.parse(record);
  await mkdir(dirname(ledgerPath), { recursive: true });
  // SEC-014 defense-in-depth: redact the structured value before serializing, matching the trajectory +
  // scoreboard chokepoints — a careless runner that puts a URL/command in `note` must not persist a
  // credential to the ledger. Redacting before stringify keeps the line valid JSON by construction (F1
  // integrity): redacting an already-serialized line could split a JSON escape into an invalid sequence.
  const line = `${JSON.stringify(redactJsonValue(valid))}\n`;
  const fh = await open(ledgerPath, "a");
  try {
    await fh.appendFile(line, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Read + validate every record. A missing file → `[]` (a fresh ledger). A non-empty line that is not
 * valid JSON or does not match `SpendRecord` throws `SpendLedgerCorruptError` naming the line number —
 * fail closed, never skip (skipping under-counts spend).
 */
export async function readSpendRecords(ledgerPath: string): Promise<SpendRecordT[]> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  // One-line actionable recovery hint (§8.6 what · why · how). A torn last line is the only
  // legitimately-recoverable case (a crash mid-append), but auto-skipping it would UNDER-count spend
  // and could authorise an over-budget run — so we fail closed and tell the human exactly what to do.
  const hint = (line: number, why: string): string =>
    `line ${line} of ${ledgerPath} ${why} — fail-closed (a corrupt ledger could authorise an ` +
    `over-budget run). Inspect it; if it is a known torn trailing append from a crashed run, ` +
    `delete that one line, then retry.`;
  const records: SpendRecordT[] = [];
  for (const [idx, rawLine] of raw.split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "") continue; // tolerate blank/trailing lines only
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SpendLedgerCorruptError(hint(idx + 1, "is not valid JSON"));
    }
    const result = SpendRecord.safeParse(parsed);
    if (!result.success) {
      throw new SpendLedgerCorruptError(hint(idx + 1, "is not a valid spend record"));
    }
    records.push(result.data);
  }
  return records;
}

/** Sum the cost of every record whose `at` falls in `now`'s UTC calendar month. Pure. The UTC month
 *  boundary (not local time) is the defined boundary (QR-1); a record from a prior/future month is
 *  excluded, so the cap "rolls over" when the calendar month changes (QR-2 spanning >1 month).
 *
 *  ADR-0048 Option A: accumulate the REAL (cache-discounted) `realCostUSD` where the record carries it, so
 *  the monthly cap is denominated in REAL dollars; a legacy record without it falls back to the
 *  conservative un-cached `costUSD` upper bound (so the rollover never *under*-counts history). The
 *  per-run pre-spend gate is unchanged — it still rides the UB estimate (see `assertRunWithinCaps`). */
export function monthToDateUSD(records: readonly SpendRecordT[], now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let total = 0;
  for (const r of records) {
    const at = new Date(r.at);
    if (at.getUTCFullYear() === y && at.getUTCMonth() === m) total += r.realCostUSD ?? r.costUSD;
  }
  return total;
}

/** Read the ledger and return the UTC month-to-date spend for `now` (fail-closed on a corrupt ledger). */
export async function readMonthToDateUSD(ledgerPath: string, now: Date): Promise<number> {
  return monthToDateUSD(await readSpendRecords(ledgerPath), now);
}

/**
 * Assert this run is within BOTH caps before any spend: the per-run cap on `estimatedUSD`, and the
 * per-month cap on (this month's recorded spend + `estimatedUSD`). Throws `CostCapError` (incl. on a
 * 0/unset cap) — the caller must not have spent anything when this throws. Reads the ledger at run start.
 */
export async function assertRunWithinCaps(
  config: EvalConfigT,
  ledgerPath: string,
  estimatedUSD: number,
  now: Date,
): Promise<void> {
  const monthToDate = await readMonthToDateUSD(ledgerPath, now);
  assertConfigCostCap(config, estimatedUSD); // per-run cap (also refuses 0/unset)
  assertConfigMonthlyCap(config, monthToDate, estimatedUSD); // per-month cap
}

/** Identity + provenance for a spend record (the bits the run knows that the cost does not). */
export interface SpendDescriptor {
  readonly runId: string;
  readonly suite: string;
  readonly model: string;
  readonly note?: string;
}

/** What a guarded spend returns: the run's value + its ACTUAL measured USD cost (for the ledger). */
export interface SpendOutcome<T> {
  readonly value: T;
  // The conservative un-cached UB on actual cost. The per-run pre-spend gate rides this; the post-spend
  // backstop checks the higher of this and `realActualUSD` against the estimate (QC §9).
  readonly actualUSD: number;
  // ADDITIVE (ADR-0048 Option A): the REAL cache-discounted cost, recorded alongside the UB `actualUSD`
  // for the monthly accumulator. OPTIONAL — a caller that does not measure it yields a legacy-shaped
  // record (only `costUSD`), which `monthToDateUSD` handles via fallback. The post-spend backstop reads
  // this too: because the monthly cap accumulates it, a cache-write premium that pushes it above the
  // estimate must halt loudly (QC §9), not silently overshoot.
  readonly realActualUSD?: number | undefined;
}

/**
 * Hold an EXCLUSIVE lock over the ledger for the duration of `fn`, then release it. Acquired by an
 * `O_EXCL` create of `<ledger>.lock`; if the lock is already held, FAIL FAST with an actionable error
 * rather than racing. This serializes the read-check-spend-record critical section across processes so
 * the monthly cap cannot be defeated by a TOCTOU (two concurrent runs both reading month-to-date before
 * either records — the owner runs parallel sessions sharing one ledger).
 *
 * Money-safe by construction: a second concurrent run REFUSES (never overspends). A crash leaves a stale
 * lock; we do NOT auto-steal it (stealing risks two live runs) — the error tells the human to remove it.
 * Tradeoff: benchmark runs serialize (cap-safety > parallelism); a reservation-based design that allows
 * parallel spends is a documented future option if the campaign needs concurrency.
 */
export async function withExclusiveLedgerLock<T>(
  ledgerPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${ledgerPath}.lock`;
  await mkdir(dirname(ledgerPath), { recursive: true });
  let fh;
  try {
    fh = await open(lockPath, "wx"); // O_EXCL — throws EEXIST if another run holds it
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      const held = await readFile(lockPath, "utf8").catch(() => "(unreadable)");
      throw new SpendLedgerCorruptError(
        `another benchmark run holds the spend lock ${lockPath} [${held.trim()}] — runs are ` +
          `serialized for cost-cap safety. Wait for it to finish; if no run is active, remove ` +
          `${lockPath} and retry.`,
      );
    }
    throw e;
  }
  try {
    await fh.write(`${new Date().toISOString()} pid ${process.pid}`);
    return await fn();
  } finally {
    await fh.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

/**
 * The single spending chokepoint. Under an exclusive ledger lock (so the cap check + record can't race
 * a concurrent run), guards the caps on `estimatedUSD` BEFORE invoking `spend` (an over-budget run never
 * reaches a paid call), then records the ACTUAL cost. After recording, asserts the recorded cost did not
 * exceed the estimate — checking the higher of the UB `actualUSD` and the accumulated `realCostUSD`
 * (QC §9), since the monthly cap rides the real figure. A breach is surfaced LOUDLY (recorded, then
 * thrown) rather than silently accepted, since cap safety rests on `max(actual, real) ≤ estimate`.
 * `now` is injectable for tests.
 *
 * ALL real benchmark spending must flow through this function — that is what makes the cost caps
 * structurally binding (QR-1), not merely declared.
 */
export async function guardedRun<T>(
  config: EvalConfigT,
  ledgerPath: string,
  descriptor: SpendDescriptor,
  estimatedUSD: number,
  spend: () => Promise<SpendOutcome<T>>,
  now: Date = new Date(),
): Promise<T> {
  return withExclusiveLedgerLock(ledgerPath, async () => {
    await assertRunWithinCaps(config, ledgerPath, estimatedUSD, now);
    const outcome = await spend();
    await appendSpendRecord(ledgerPath, {
      runId: descriptor.runId,
      at: now.toISOString(),
      costUSD: outcome.actualUSD, // the conservative un-cached UB — kept as the safe ledger ceiling
      // ADR-0048 Option A: record the REAL cache-discounted cost additively when the spend measured it,
      // so the monthly accumulator reflects real dollars (legacy/omitting callers stay UB-only).
      ...(outcome.realActualUSD !== undefined ? { realCostUSD: outcome.realActualUSD } : {}),
      suite: descriptor.suite,
      model: descriptor.model,
      ...(descriptor.note !== undefined ? { note: descriptor.note } : {}),
    });
    // Post-spend money-safety backstop: the cap guard ran on the estimate; if the recorded cost
    // exceeded it, the estimate failed its upper-bound contract — halt loudly so a broken estimator
    // can't silently keep blowing the cap on subsequent runs (the spend is already recorded above).
    // Both the UB `actualUSD` AND the REAL cache-discounted cost are checked: the monthly cap
    // accumulates `realCostUSD` (monthToDateUSD), so a cache-write-heavy run whose real cost exceeds
    // the estimate by the 1.25× write premium (ADR-0047) would silently overshoot month-to-date if
    // only the UB were checked (QC §9).
    const recordedCost = Math.max(outcome.actualUSD, outcome.realActualUSD ?? 0);
    if (recordedCost > estimatedUSD) {
      const basis =
        (outcome.realActualUSD ?? 0) > outcome.actualUSD ? "real (cache-billed)" : "actual";
      throw new CostCapError(
        `run "${descriptor.runId}" ${basis} cost $${String(recordedCost)} exceeded its pre-run ` +
          `estimate $${String(estimatedUSD)} (the estimate must be a worst-case upper bound over the ` +
          `billed cost). Recorded, but halting — fix the cost estimator before continuing.`,
      );
    }
    return outcome.value;
  });
}
