import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostCapError } from "./cost-cap.js";
import { defaultEvalConfig } from "./config.default.js";
import type { EvalConfigT } from "./config.js";
import {
  SpendLedgerCorruptError,
  type SpendDescriptor,
  appendSpendRecord,
  assertRunWithinCaps,
  guardedRun,
  monthToDateUSD,
  readMonthToDateUSD,
  readSpendRecords,
  withExclusiveLedgerLock,
} from "./spend-ledger.js";

// A config whose caps are easy to reason about: $25/run, $300/mo (the ADR-0022 pins).
const CONFIG: EvalConfigT = defaultEvalConfig;
const DESC: SpendDescriptor = {
  runId: "run-1",
  suite: "terminal-bench-2",
  model: "claude-sonnet-4-6",
};
const JUNE = new Date("2026-06-16T12:00:00.000Z");

let dir: string;
let ledger: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "keel-spend-"));
  ledger = join(dir, "spend-ledger.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("spend ledger — durable append + reload", () => {
  it("appends records and reads them back (round-trip)", async () => {
    await appendSpendRecord(ledger, {
      runId: "r1",
      at: "2026-06-01T00:00:00.000Z",
      costUSD: 12.5,
      suite: "terminal-bench-2",
      model: "claude-sonnet-4-6",
    });
    await appendSpendRecord(ledger, {
      runId: "r2",
      at: "2026-06-02T00:00:00.000Z",
      costUSD: 7.25,
      suite: "terminal-bench-2",
      model: "claude-sonnet-4-6",
    });
    const records = await readSpendRecords(ledger);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ runId: "r1", costUSD: 12.5 });
    expect(records[1]).toMatchObject({ runId: "r2", costUSD: 7.25 });
  });

  it("creates the parent directory if missing", async () => {
    const nested = join(dir, "a", "b", "spend.jsonl");
    await appendSpendRecord(nested, {
      runId: "r1",
      at: "2026-06-01T00:00:00.000Z",
      costUSD: 1,
      suite: "s",
      model: "m",
    });
    expect(await readSpendRecords(nested)).toHaveLength(1);
  });

  it("a missing ledger reads as empty (month-to-date 0) — a fresh ledger is not an error", async () => {
    expect(await readSpendRecords(ledger)).toEqual([]);
    expect(await readMonthToDateUSD(ledger, JUNE)).toBe(0);
  });

  it("surfaces a non-ENOENT read error (does NOT swallow it as an empty ledger)", async () => {
    // Pointing at a directory makes readFile fail with EISDIR — only ENOENT (no file yet) may be
    // treated as an empty ledger; any other IO error must propagate, never under-count to $0.
    await expect(readSpendRecords(dir)).rejects.toThrow();
    await expect(readSpendRecords(dir)).rejects.not.toThrow(SpendLedgerCorruptError);
  });

  it("FAILS CLOSED on a corrupt ledger line (never silently under-counts spend)", async () => {
    await appendSpendRecord(ledger, {
      runId: "r1",
      at: "2026-06-01T00:00:00.000Z",
      costUSD: 5,
      suite: "s",
      model: "m",
    });
    await writeFile(ledger, (await readFile(ledger, "utf8")) + "{ not json\n");
    await expect(readSpendRecords(ledger)).rejects.toThrow(SpendLedgerCorruptError);
    await expect(readMonthToDateUSD(ledger, JUNE)).rejects.toThrow(SpendLedgerCorruptError);
  });

  it("FAILS CLOSED on a schema-invalid record (negative cost)", async () => {
    await writeFile(
      ledger,
      JSON.stringify({
        runId: "r",
        at: "2026-06-01T00:00:00.000Z",
        costUSD: -1,
        suite: "s",
        model: "m",
      }) + "\n",
    );
    await expect(readSpendRecords(ledger)).rejects.toThrow(SpendLedgerCorruptError);
  });
});

describe("spend ledger — UTC month-to-date aggregation", () => {
  const records = [
    { runId: "may", at: "2026-05-31T23:59:59.000Z", costUSD: 100, suite: "s", model: "m" },
    { runId: "jun-a", at: "2026-06-01T00:00:00.000Z", costUSD: 10, suite: "s", model: "m" },
    { runId: "jun-b", at: "2026-06-16T12:00:00.000Z", costUSD: 5, suite: "s", model: "m" },
    { runId: "jul", at: "2026-07-01T00:00:00.000Z", costUSD: 100, suite: "s", model: "m" },
  ];

  it("sums only records in `now`'s UTC calendar month (rollover excludes prior/future months)", () => {
    expect(monthToDateUSD(records, JUNE)).toBe(15); // jun-a + jun-b only
  });

  it("uses the UTC month boundary, not local time", () => {
    // 2026-06-01T00:30 UTC is still June in UTC even where local time is May 31 (UTC-…).
    const justAfterBoundary = new Date("2026-06-01T00:30:00.000Z");
    expect(monthToDateUSD(records, justAfterBoundary)).toBe(15);
    // A record exactly at the May→June boundary instant belongs to June.
    expect(
      monthToDateUSD(
        [{ runId: "edge", at: "2026-06-01T00:00:00.000Z", costUSD: 3, suite: "s", model: "m" }],
        JUNE,
      ),
    ).toBe(3);
  });

  it("a different month sees a different (rolled-over) total", () => {
    expect(monthToDateUSD(records, new Date("2026-07-15T00:00:00.000Z"))).toBe(100); // jul only
    expect(monthToDateUSD(records, new Date("2026-05-15T00:00:00.000Z"))).toBe(100); // may only
  });
});

describe("spend ledger — the spending chokepoint (the money-safety gate)", () => {
  it("refuses an over-perMonth run BEFORE any spend, and records nothing", async () => {
    // Month-to-date $290; perMonth $300; a $25 run would project to $315 > $300.
    await appendSpendRecord(ledger, {
      runId: "prior",
      at: "2026-06-10T00:00:00.000Z",
      costUSD: 290,
      suite: "s",
      model: "m",
    });
    let spendCalled = false;
    const spend = async () => {
      spendCalled = true;
      return { value: "result", actualUSD: 25 };
    };
    await expect(guardedRun(CONFIG, ledger, DESC, 25, spend, JUNE)).rejects.toThrow(CostCapError);
    // The single most important assertion in this epic: the spend callback NEVER ran.
    expect(spendCalled).toBe(false);
    // And nothing was appended — the ledger still shows only the prior $290 record.
    const after = await readSpendRecords(ledger);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ runId: "prior" });
  });

  it("refuses an over-perRun run before any spend (estimate exceeds the per-run cap)", async () => {
    let spendCalled = false;
    const spend = async () => {
      spendCalled = true;
      return { value: "x", actualUSD: 1 };
    };
    // $26 estimate > $25/run cap, even on a fresh ledger.
    await expect(guardedRun(CONFIG, ledger, DESC, 26, spend, JUNE)).rejects.toThrow(CostCapError);
    expect(spendCalled).toBe(false);
    expect(await readSpendRecords(ledger)).toEqual([]);
  });

  it("refuses when the cap is 0/unset (never a license to spend), before any spend", async () => {
    const zeroCap: EvalConfigT = { ...CONFIG, costCapUSD: { perRun: 0, perMonth: 0 } };
    let spendCalled = false;
    await expect(
      guardedRun(
        zeroCap,
        ledger,
        DESC,
        1,
        async () => {
          spendCalled = true;
          return { value: "x", actualUSD: 1 };
        },
        JUNE,
      ),
    ).rejects.toThrow(CostCapError);
    expect(spendCalled).toBe(false);
  });

  it("allows a within-budget run, records the ACTUAL cost, and the next month-to-date reflects it", async () => {
    const value = await guardedRun(
      CONFIG,
      ledger,
      DESC,
      25, // estimate (upper-bound ceiling) within $25/run
      async () => ({ value: 42, actualUSD: 18.4 }), // actual measured cost
      JUNE,
    );
    expect(value).toBe(42);
    const records = await readSpendRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: "run-1",
      costUSD: 18.4,
      at: JUNE.toISOString(),
    });
    // Month-to-date now reflects the ACTUAL spend, not the estimate.
    expect(await readMonthToDateUSD(ledger, JUNE)).toBe(18.4);
  });

  it("preserves a descriptor note on the recorded run", async () => {
    await guardedRun(
      CONFIG,
      ledger,
      { ...DESC, note: "B1 smoke" },
      10,
      async () => ({ value: null, actualUSD: 3 }),
      JUNE,
    );
    const records = await readSpendRecords(ledger);
    expect(records[0]).toMatchObject({ costUSD: 3, note: "B1 smoke" });
  });

  it("assertRunWithinCaps reads month-to-date from the ledger and projects this run's estimate", async () => {
    await appendSpendRecord(ledger, {
      runId: "prior",
      at: "2026-06-10T00:00:00.000Z",
      costUSD: 280,
      suite: "s",
      model: "m",
    });
    // 280 + 19 = 299 ≤ 300 → allowed; 280 + 21 = 301 > 300 → refused.
    await expect(assertRunWithinCaps(CONFIG, ledger, 19, JUNE)).resolves.toBeUndefined();
    await expect(assertRunWithinCaps(CONFIG, ledger, 21, JUNE)).rejects.toThrow(CostCapError);
  });
});

describe("spend ledger — concurrency lock (the monthly-cap TOCTOU fix)", () => {
  it("two concurrent guarded runs do NOT both authorize — the second refuses, the cap holds", async () => {
    // perMonth = $10; each run estimates+spends $6. Without the lock, both read MTD=$0 and both
    // authorize → $12 > $10. With the exclusive lock, exactly one proceeds and the other refuses.
    const cfg: EvalConfigT = { ...CONFIG, costCapUSD: { perRun: 25, perMonth: 10 } };
    const run = (id: string) =>
      guardedRun(
        cfg,
        ledger,
        { ...DESC, runId: id },
        6,
        async () => {
          await new Promise((r) => setTimeout(r, 20)); // hold the critical section briefly
          return { value: id, actualUSD: 6 };
        },
        JUNE,
      );
    const results = await Promise.allSettled([run("a"), run("b")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // The ledger holds exactly one $6 record — never $12.
    const total = (await readSpendRecords(ledger)).reduce((s, r) => s + r.costUSD, 0);
    expect(total).toBe(6);
  });

  it("releases the lock after a run so the next run can proceed", async () => {
    await guardedRun(CONFIG, ledger, DESC, 5, async () => ({ value: 1, actualUSD: 5 }), JUNE);
    // a second sequential run must succeed (lock released) — no leftover .lock blocking it
    await expect(
      guardedRun(
        CONFIG,
        ledger,
        { ...DESC, runId: "r2" },
        5,
        async () => ({ value: 2, actualUSD: 5 }),
        JUNE,
      ),
    ).resolves.toBe(2);
  });

  it("withExclusiveLedgerLock refuses a second holder with an actionable message", async () => {
    let released!: () => void;
    const inside = new Promise<void>((r) => (released = r));
    const first = withExclusiveLedgerLock(ledger, async () => {
      await inside; // hold the lock until we let go
    });
    await new Promise((r) => setTimeout(r, 10));
    await expect(withExclusiveLedgerLock(ledger, async () => "second")).rejects.toThrow(
      /holds the spend lock|serialized for cost-cap/,
    );
    released();
    await first;
  });
});

describe("spend ledger — post-spend estimate backstop + note redaction", () => {
  it("halts loudly if the ACTUAL cost exceeds the pre-run estimate (still recording it)", async () => {
    await expect(
      guardedRun(CONFIG, ledger, DESC, 5, async () => ({ value: "x", actualUSD: 9 }), JUNE),
    ).rejects.toThrow(CostCapError);
    // The breaching spend WAS recorded (so month-to-date is truthful), but the run halted loudly.
    const records = await readSpendRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ costUSD: 9 });
  });

  it("halts loudly if the REAL (cache-discounted) cost exceeds the pre-run estimate (QC §9)", async () => {
    // The UB `actualUSD` is within the estimate, but the REAL cost — which the MONTHLY cap
    // accumulates (monthToDateUSD prefers realCostUSD) — exceeds it. This is reachable on a
    // cache-write-heavy run billed at the 1.25× write premium (ADR-0047). If the backstop only
    // rode the UB, month-to-date real spend would silently overshoot the cap; it must halt.
    await expect(
      guardedRun(
        CONFIG,
        ledger,
        DESC,
        5,
        async () => ({ value: "x", actualUSD: 4, realActualUSD: 9 }),
        JUNE,
      ),
    ).rejects.toThrow(CostCapError);
    const records = await readSpendRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ costUSD: 4, realCostUSD: 9 });
  });

  it("does not halt when the real cost stays within the estimate (normal cache-discounted run)", async () => {
    const value = await guardedRun(
      CONFIG,
      ledger,
      DESC,
      5,
      async () => ({ value: "ok", actualUSD: 5, realActualUSD: 2 }),
      JUNE,
    );
    expect(value).toBe("ok");
  });

  it("redacts a credential planted in a descriptor note before persisting it", async () => {
    const key = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";
    await guardedRun(
      CONFIG,
      ledger,
      { ...DESC, note: `ran with ${key}` },
      5,
      async () => ({ value: null, actualUSD: 3 }),
      JUNE,
    );
    const raw = await readFile(ledger, "utf8");
    expect(raw).not.toContain(key);
    expect(raw).toContain("[redacted:anthropic-key]");
    // still valid + reloadable
    expect((await readSpendRecords(ledger))[0]?.note).toContain("[redacted:anthropic-key]");
  });
});

describe("spend ledger — real-cost accounting (ADR-0048 Option A)", () => {
  it("round-trips the additive realCostUSD (present) and a legacy record (absent)", async () => {
    await appendSpendRecord(ledger, {
      runId: "withReal",
      at: "2026-06-01T00:00:00.000Z",
      costUSD: 9,
      realCostUSD: 2.5,
      suite: "s",
      model: "m",
    });
    await appendSpendRecord(ledger, {
      runId: "legacy",
      at: "2026-06-01T00:00:00.000Z",
      costUSD: 9, // a pre-ADR-0048 record carries no realCostUSD — must still parse
      suite: "s",
      model: "m",
    });
    const records = await readSpendRecords(ledger);
    expect(records[0]).toMatchObject({ runId: "withReal", costUSD: 9, realCostUSD: 2.5 });
    expect(records[1]).toMatchObject({ runId: "legacy", costUSD: 9 });
    expect(records[1]?.realCostUSD).toBeUndefined();
  });

  it("FAILS CLOSED on a negative realCostUSD (the additive field is bounds-checked like costUSD)", async () => {
    await writeFile(
      ledger,
      JSON.stringify({
        runId: "r",
        at: "2026-06-01T00:00:00.000Z",
        costUSD: 5,
        realCostUSD: -1,
        suite: "s",
        model: "m",
      }) + "\n",
    );
    await expect(readSpendRecords(ledger)).rejects.toThrow(SpendLedgerCorruptError);
  });

  it("monthToDateUSD prefers realCostUSD per record, falling back to costUSD for legacy records", () => {
    const mixed = [
      // new record: both present → the REAL figure (3) is used, NOT the UB (30)
      {
        runId: "new",
        at: "2026-06-02T00:00:00.000Z",
        costUSD: 30,
        realCostUSD: 3,
        suite: "s",
        model: "m",
      },
      // legacy record: only costUSD → the conservative UB (10) is used (no under-count)
      { runId: "legacy", at: "2026-06-03T00:00:00.000Z", costUSD: 10, suite: "s", model: "m" },
    ];
    expect(monthToDateUSD(mixed, JUNE)).toBe(13); // 3 (real) + 10 (UB fallback)
  });

  it("guardedRun records BOTH the UB costUSD and the real realCostUSD; month-to-date uses the real", async () => {
    await guardedRun(
      CONFIG,
      ledger,
      DESC,
      25, // estimate (UB ceiling)
      async () => ({ value: 42, actualUSD: 18.4, realActualUSD: 4.1 }), // UB actual + real actual
      JUNE,
    );
    const records = await readSpendRecords(ledger);
    expect(records[0]).toMatchObject({ runId: "run-1", costUSD: 18.4, realCostUSD: 4.1 });
    // The monthly accumulator reflects the REAL spend (4.1), not the conservative UB (18.4).
    expect(await readMonthToDateUSD(ledger, JUNE)).toBe(4.1);
  });

  it("a spend that omits realActualUSD yields a legacy-shaped record; month-to-date falls back to the UB", async () => {
    await guardedRun(CONFIG, ledger, DESC, 25, async () => ({ value: 1, actualUSD: 12 }), JUNE);
    const records = await readSpendRecords(ledger);
    expect(records[0]).toMatchObject({ costUSD: 12 });
    expect(records[0]?.realCostUSD).toBeUndefined();
    // No real figure measured → the accumulator uses the conservative UB (12), never under-counting.
    expect(await readMonthToDateUSD(ledger, JUNE)).toBe(12);
  });

  it("the post-spend backstop rides the UB actualUSD, NEVER the discounted realActualUSD", async () => {
    // estimate $5; UB actual $9 (> estimate) but real $1 (well under). The guard MUST halt on the UB,
    // proving the discounted figure is never a license to exceed the per-run estimate (money-safety).
    await expect(
      guardedRun(
        CONFIG,
        ledger,
        DESC,
        5,
        async () => ({ value: "x", actualUSD: 9, realActualUSD: 1 }),
        JUNE,
      ),
    ).rejects.toThrow(CostCapError);
    // Both figures are still recorded (the spend happened): costUSD = UB (9), realCostUSD = real (1).
    const records = await readSpendRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ costUSD: 9, realCostUSD: 1 });
  });

  it("the monthly cap is denominated in REAL dollars (Option A); the legacy fallback stays conservative", async () => {
    // perMonth $300. A prior run billed a UB $290 but a REAL $50 (cache-heavy). A new $25 run:
    //  - against REAL history ($50): 50 + 25 = 75 ≤ 300 → ALLOWED (the Option-A recalibration).
    await appendSpendRecord(ledger, {
      runId: "prior",
      at: "2026-06-10T00:00:00.000Z",
      costUSD: 290,
      realCostUSD: 50,
      suite: "s",
      model: "m",
    });
    const value = await guardedRun(
      CONFIG,
      ledger,
      DESC,
      25,
      async () => ({ value: "ok", actualUSD: 20, realActualUSD: 4 }),
      JUNE,
    );
    expect(value).toBe("ok");

    // Contrast: the SAME prior spend as a LEGACY record (no realCostUSD) falls back to the UB $290, and
    // the identical new run is REFUSED — 290 + 25 = 315 > 300. The fallback never under-counts history.
    const legacyLedger = join(dir, "legacy-ledger.jsonl");
    await appendSpendRecord(legacyLedger, {
      runId: "prior",
      at: "2026-06-10T00:00:00.000Z",
      costUSD: 290,
      suite: "s",
      model: "m",
    });
    await expect(
      guardedRun(
        CONFIG,
        legacyLedger,
        { ...DESC, runId: "r2" },
        25,
        async () => ({ value: "x", actualUSD: 20, realActualUSD: 4 }),
        JUNE,
      ),
    ).rejects.toThrow(CostCapError);
  });
});
