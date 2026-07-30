import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionStore,
  readSession,
  SessionCorruptError,
  SessionNewerVersionError,
  SessionRedactionConflictError,
} from "./store.js";
import { sessionPath, sessionsDir } from "./paths.js";
import { parseGoalArgs } from "../run/run-control-parser.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
const userEv = (content: string) =>
  ({ type: "user", v: 1, ts: "2026-06-14T00:00:00.000Z", content }) as const;

describe("SessionStore + readSession", () => {
  it("create writes a session_meta header as line 1; append adds events", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append(userEv("hi"));
    s.close();
    const file = readSession(s.id, e);
    expect(file.meta.type).toBe("session_meta");
    expect(file.meta.id).toBe(s.id);
    expect(file.meta.cwd).toBe("/w");
    expect(file.events.map((x) => x.type)).toEqual(["user"]);
    expect(file.events[0]).toMatchObject({ content: "hi" });
  });

  it("creates the sessions dir 0700 and the ledger file 0600 (owner-only, like the credentials store)", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append(userEv("hi"));
    s.close();
    // The ledger can hold redacted-but-best-effort content; a residual secret a filter missed must not
    // sit in a world-readable file on a multi-user host (SEC-1). Mirror the 0600 credentials posture.
    expect(statSync(sessionsDir(e)).mode & 0o777).toBe(0o700);
    expect(statSync(sessionPath(s.id, e)).mode & 0o777).toBe(0o600);
  });

  it("open(id) reopens an existing session for append — no second header; turns accrue under one ledger (Epic 1.23 resume)", () => {
    const e = env();
    const s1 = SessionStore.create({ cwd: "/w" }, e);
    s1.append(userEv("first turn"));
    s1.close();

    // Resume: reopen the SAME session and append more — append-only, no new session_meta header.
    const s2 = SessionStore.open(s1.id, e);
    expect(s2.id).toBe(s1.id);
    s2.append(userEv("second turn"));
    s2.close();

    const file = readSession(s1.id, e);
    expect(file.meta.id).toBe(s1.id); // still exactly one header (line 1)
    expect(file.events.some((ev) => ev.type === "session_meta")).toBe(false); // NO second header appended
    expect(
      file.events
        .filter((ev) => ev.type === "user")
        .map((ev) => (ev as { content: string }).content),
    ).toEqual(["first turn", "second turn"]); // both turns, in order, immutably preserved
  });

  it("open fails closed on a missing session (never silently creates a headerless ledger)", () => {
    const e = env();
    expect(() => SessionStore.open("ses_01ARZ3NDEKTSV4RRFFQ69G5FAV", e)).toThrow();
  });

  it("a custom id is honored and used in the file path", () => {
    const e = env();
    const id = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const s = SessionStore.create({ cwd: "/w", id }, e);
    s.close();
    expect(s.id).toBe(id);
    expect(readSession(id, e).meta.id).toBe(id);
  });

  it("drops a torn final line, keeps complete prior events", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append(userEv("hi"));
    s.close();
    const path = join(e["KEEL_HOME"] as string, "sessions", `${s.id}.jsonl`);
    // simulate a crash mid-write: a partial, newline-less final line
    writeFileSync(path, readFileSync(path, "utf8") + '{"type":"user","v":1,"ts":"2026');
    const file = readSession(s.id, e);
    expect(file.events.map((x) => x.type)).toEqual(["user"]); // torn tail dropped
  });

  it("throws SessionCorruptError on a corrupt NON-final line", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.close();
    const path = join(e["KEEL_HOME"] as string, "sessions", `${s.id}.jsonl`);
    const meta = readFileSync(path, "utf8");
    writeFileSync(
      path,
      meta + "GARBAGE\n" + JSON.stringify(userEv("x")) + "\n", // corruption before a valid line
    );
    expect(() => readSession(s.id, e)).toThrow(SessionCorruptError);
  });

  it("throws SessionCorruptError when the first line is not a session_meta header", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.close();
    const path = join(e["KEEL_HOME"] as string, "sessions", `${s.id}.jsonl`);
    writeFileSync(path, JSON.stringify(userEv("no header")) + "\n");
    expect(() => readSession(s.id, e)).toThrow(SessionCorruptError);
  });

  it("releases the fd (and rethrows) if the header write fails", () => {
    const e = env();
    // a malformed parent id makes the header fail SessionEvent.parse during create's append
    expect(() =>
      SessionStore.create({ cwd: "/w", parent: { id: "bad", atIndex: 0 } }, e),
    ).toThrow();
  });

  it("append after close throws (the write fd is released)", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.close();
    expect(() => s.append(userEv("after close"))).toThrow();
  });

  // Crash-safety (the spec's kill -9 property): truncating the ledger at ANY byte offset
  // never yields a wrong history — past the header it is always a clean prefix of the
  // events; truncated within the header it is unreadable (throws), never silently partial.
  it("tolerates truncation at any offset (crash-safety property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 12 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (contents, frac) => {
          const e = env();
          const s = SessionStore.create({ cwd: "/w" }, e);
          for (const c of contents) s.append(userEv(c));
          s.close();
          const path = join(e["KEEL_HOME"] as string, "sessions", `${s.id}.jsonl`);
          const full = readFileSync(path);
          // The header is readable once its JSON is complete — even if the trailing
          // newline was cut (a fully-written event that just lost its newline is kept).
          const headerJsonBytes = full.indexOf(0x0a);
          const cut = Math.floor(frac * full.length);
          writeFileSync(path, full.subarray(0, cut));

          if (cut < headerJsonBytes) {
            expect(() => readSession(s.id, e)).toThrow(SessionCorruptError);
          } else {
            const got = readSession(s.id, e).events;
            expect(got.length).toBeLessThanOrEqual(contents.length);
            got.forEach((ev, i) => expect(ev).toMatchObject({ content: contents[i] }));
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("readSession — tolerant reader + honest higher-version (ADR-0072 P1-12 Slice 5)", () => {
  /** Write a ledger: the real session_meta header (line 1) + hand-crafted raw lines. */
  function ledger(e: NodeJS.ProcessEnv, ...rawEventLines: string[]): string {
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.close();
    const path = join(e["KEEL_HOME"] as string, "sessions", `${s.id}.jsonl`);
    const header = readFileSync(path, "utf8");
    writeFileSync(path, header + rawEventLines.map((l) => l + "\n").join(""));
    return s.id;
  }

  it("tolerates an unknown additive field on a known event and resumes", () => {
    const e = env();
    const id = ledger(
      e,
      '{"type":"user","v":1,"ts":"2026-07-16T00:00:00.000Z","content":"hi","futureField":{"x":1}}',
    );
    const file = readSession(id, e);
    expect(file.events.map((x) => x.type)).toEqual(["user"]);
    expect(file.events[0]).toMatchObject({ content: "hi" });
  });

  it("refuses a higher `v` with an honest upgrade message — NOT the corruption vocabulary", () => {
    const e = env();
    const id = ledger(e, '{"type":"user","v":2,"ts":"2026-07-16T00:00:00.000Z","content":"hi"}');
    expect(() => readSession(id, e)).toThrow(SessionNewerVersionError);
    try {
      readSession(id, e);
    } catch (err) {
      expect((err as Error).message).toMatch(/newer keel/i);
      expect((err as Error).message).not.toMatch(/corrupt/i);
      expect(err).not.toBeInstanceOf(SessionCorruptError);
    }
  });

  it("refuses an unrecognized event `type` (a newer keel's variant) with the honest upgrade message", () => {
    const e = env();
    const id = ledger(
      e,
      '{"type":"widget.frobnicate","v":1,"ts":"2026-07-16T00:00:00.000Z","content":"x"}',
    );
    expect(() => readSession(id, e)).toThrow(SessionNewerVersionError);
  });

  it("still fails closed on genuine corruption (garbage non-final line)", () => {
    const e = env();
    const id = ledger(
      e,
      "NOT JSON",
      '{"type":"user","v":1,"ts":"2026-07-16T00:00:00.000Z","content":"x"}',
    );
    expect(() => readSession(id, e)).toThrow(SessionCorruptError);
  });

  it("still rejects a malformed KNOWN field on a v:1 event (tolerant is not credulous)", () => {
    const e = env();
    const id = ledger(e, '{"type":"user","v":1,"ts":"not-a-timestamp","content":"x"}');
    expect(() => readSession(id, e)).toThrow(SessionCorruptError);
  });

  it("treats a valid-JSON but non-object line as corrupt, NOT a newer-keel version", () => {
    const e = env();
    // A bare primitive parses as JSON but has no `v`/`type` envelope — genuine corruption, and the
    // null/primitive guard in newerKeelReason must NOT misclassify it as an honest-upgrade case.
    const id = ledger(e, "42");
    expect(() => readSession(id, e)).toThrow(SessionCorruptError);
    expect(() => readSession(id, e)).not.toThrow(SessionNewerVersionError);
  });
});

describe("SEC-014 redaction vs schema-validated ledger fields", () => {
  it("a goal_started event for a long /goal objective round-trips the ledger", () => {
    // Regression (2026-07-18 audit): the generated goal id crossed the entropy net's 44-char
    // floor, was redacted to `[redacted:high-entropy]` at the write chokepoint, and the ledger
    // then failed to read (RunControlId rejects the marker → SessionCorruptError) — bricking
    // resume for any /goal objective longer than ~31 chars.
    const e = env();
    const parsed = parseGoalArgs(
      'fix the flaky warden handshake timeout under load --check "pnpm test"',
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error);

    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "goal_started", v: 1, ts: "2026-07-18T00:00:00.000Z", goal: parsed.goal });
    s.close();

    const file = readSession(s.id, e);
    expect(file.events[0]).toMatchObject({ type: "goal_started", goal: { id: parsed.goal.id } });
  });

  it("append fails closed — loudly, writing nothing — when redaction would corrupt a schema-validated field (denied path)", () => {
    // The write-time counterpart of "the file is never corrupt beyond the final line": if the
    // redaction filter transforms an event so it no longer satisfies its own schema, appending it
    // would plant a line every future read rejects as corrupt. Refuse at the chokepoint instead.
    // Vehicle: a warden_auto_resolved domain whose single label is a 44-char high-entropy run —
    // schema-valid before redaction, marker-mangled after.
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    const label = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2";
    expect(() =>
      s.append({
        type: "warden_auto_resolved",
        v: 1,
        ts: "2026-07-18T00:00:00.000Z",
        source: "session-grant",
        resource: { kind: "domain", value: `${label}.example.com` },
        reviewId: "rev-1",
        scope: "once",
        auditSeq: 1,
        verdict: "allow",
        toolCallId: "call-1",
        toolName: "bash",
      }),
    ).toThrowError(SessionRedactionConflictError);
    s.close();

    const file = readSession(s.id, e); // ledger must remain readable —
    expect(file.events).toEqual([]); // — and must have gained no line at all
  });

  it("a ledger corrupted by the PRE-fix redaction collision stays refused as corrupt, not resumed and not 'newer keel'", () => {
    // Fixture from the 2026-07-18 audit: the line below is byte-exact what the pre-fix write
    // chokepoint persisted for `/goal fix the flaky warden handshake timeout under load` — the
    // old 80-char slug crossed the entropy net's floor and the goal id was redacted to the
    // marker (reconstructed with the pre-fix stableId + the unchanged redactJsonLine, since the
    // audit's live sessions never got a goal_started line on disk). The fix prevents NEW
    // corruption; ledgers already written this way must keep failing with the honest corruption
    // vocabulary — loudly, at the exact line — not be silently skipped by a future "tolerant"
    // reader relaxation and not be misread as an upgrade case.
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.close();
    const path = sessionPath(s.id, e);
    const preFixCorruptLine =
      '{"type":"goal_started","v":1,"ts":"2026-07-18T00:00:00.000Z","goal":{"schemaVersion":"run-control.keel.dev/v1","id":"[redacted:high-entropy]","objective":"fix the flaky warden handshake timeout under load","doneWhen":[{"id":"check-1","kind":"command","check":{"argv":["pnpm","test"]}}],"validation":{"tier":"standard"},"requiresCompletionAudit":true}}';
    writeFileSync(path, readFileSync(path, "utf8") + preFixCorruptLine + "\n");

    expect(() => readSession(s.id, e)).toThrow(SessionCorruptError);
    expect(() => readSession(s.id, e)).not.toThrow(SessionNewerVersionError);
  });
});
