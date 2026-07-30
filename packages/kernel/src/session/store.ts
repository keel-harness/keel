import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_SCHEMA_VERSION,
  SessionEvent,
  type SessionEventT,
  SessionEventTolerant,
  newSessionId,
} from "@keel/shared";
import { redactJsonLine } from "../secrets/redact.js";
import { sessionPath, sessionsDir } from "./paths.js";
import { workspaceKey } from "./workspace-key.js";

/** The session_meta header variant of the ledger union. */
export type SessionMetaT = Extract<SessionEventT, { type: "session_meta" }>;

/** A parsed session ledger: its header + the events after it. */
export interface SessionFile {
  readonly meta: SessionMetaT;
  readonly events: SessionEventT[];
}

/** A session ledger could not be read because a NON-final line is corrupt, or the
 *  header is missing. A torn *final* line is tolerated, not an error (see readSessionFile). */
export class SessionCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCorruptError";
  }
}

/** A session ledger was written by a NEWER keel — it carries an event schema version (`v`) or an
 *  event `type` this keel does not recognize (ADR-0072 §4). The ledger is not corrupt; this keel
 *  simply cannot safely resume it. Distinct from {@link SessionCorruptError} so callers render an
 *  honest "upgrade keel" message rather than the corruption vocabulary. */
export class SessionNewerVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNewerVersionError";
  }
}

/** An append was REFUSED because the SEC-014 redaction filter transformed the event into one that
 *  no longer satisfies its own schema (e.g. a schema-validated id/domain field collapsed to a
 *  `[redacted:…]` marker). Writing it would plant a line every future read rejects as corrupt
 *  (an unresumable ledger), so the chokepoint fails closed instead — nothing is written, the
 *  ledger stays valid, and the conflict surfaces HERE, at write time, where it is diagnosable. */
export class SessionRedactionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRedactionConflictError";
  }
}

/**
 * If `event` was written by a newer keel — a higher `v`, or an unrecognized `type` — return an
 * honest upgrade reason; otherwise `undefined`. A `v` this keel doesn't recognize higher than its
 * own, or a novel event type, both mean "upgrade to resume" rather than "corrupt": the session
 * ledger's integrity is not in question, only this keel's ability to interpret it (ADR-0072 §4).
 */
function newerKeelReason(event: unknown, path: string): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const version = record["v"];
  if (typeof version === "number" && version > SESSION_SCHEMA_VERSION) {
    return `session ${path} was written by a newer keel (event schema v${version}); upgrade keel to resume it`;
  }
  const type = record["type"];
  if (typeof type === "string" && !KNOWN_SESSION_EVENT_TYPES.has(type)) {
    return `session ${path} contains an event type ${JSON.stringify(type)} this keel does not recognize; it was written by a newer keel — upgrade keel to resume it`;
  }
  return undefined;
}

export interface SessionCreateOpts {
  readonly cwd: string;
  /** Override the generated id (e.g. `branch` supplies a fresh one). */
  readonly id?: string;
  /** Branch lineage recorded in the header. */
  readonly parent?: { readonly id: string; readonly atIndex: number };
}

/**
 * Append-only JSONL session ledger writer (ADR-0008, §4.7.1-A — the canonical source
 * of truth). One kernel process writes a session via a held append-mode fd; readers are
 * concurrent-safe because the log is append-only. Each event is written in full and
 * `fsync`'d, so the record is durable past a power loss and a process death can leave at
 * most a torn final line — which `readSessionFile` drops. `close()` releases the fd
 * (appending after close throws).
 */
export class SessionStore {
  private constructor(
    readonly id: string,
    private readonly fd: number,
  ) {}

  /** Create a new session: mkdir the sessions dir, open the append fd, write the header. */
  static create(opts: SessionCreateOpts, env: NodeJS.ProcessEnv = process.env): SessionStore {
    const id = opts.id ?? newSessionId();
    // Owner-only (0700 dir / 0600 file), mirroring the credentials store: the ledger holds
    // redacted-but-best-effort content, so a residual secret a filter missed must not land in a
    // world-readable file on a multi-user host (SEC-1). `chmodSync` tightens a pre-existing dir that
    // an older install (or a permissive umask) may have created looser; the file mode is set at
    // creation by the `openSync` mode arg.
    const dir = sessionsDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const fd = openSync(sessionPath(id, env), "a", 0o600);
    const store = new SessionStore(id, fd);
    try {
      store.append({
        type: "session_meta",
        v: 1,
        id,
        createdAt: new Date().toISOString(),
        cwd: opts.cwd,
        cwdHash: workspaceKey(opts.cwd), // stable one-way workspace identity for --continue (ADR-0054)
        ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
      });
    } catch (e) {
      store.close(); // release the fd if the header write fails — no descriptor leak
      throw e;
    }
    return store;
  }

  /**
   * Reopen an EXISTING session ledger for append — the `keel --continue` / `--resume <id>` path
   * (Epic 1.23). Append-only is preserved: this writes NO new header (the `session_meta` is already
   * line 1) and never rewrites a prior event, so the resumed history stays immutable and the
   * continuation is one growing thread under one id (continue-not-branch; see the design doc). Fails
   * closed if the session does not exist, so a typo can never silently create a headerless ledger.
   * The caller validates the ledger's contents via `readSession`/`rebuild` before continuing.
   */
  static open(id: string, env: NodeJS.ProcessEnv = process.env): SessionStore {
    const path = sessionPath(id, env);
    if (!existsSync(path)) throw new SessionCorruptError(`session ${id} not found`);
    return new SessionStore(id, openSync(path, "a"));
  }

  /** Append one validated event as a single newline-terminated line, then fsync. The
   *  write loops only to satisfy a short syscall; a crash mid-line leaves a torn final
   *  line the reader discards, never a corrupt earlier event.
   *
   *  Secrets are **redacted at this single write chokepoint** (SEC-014, §3.2(6)): the serialized
   *  event passes through `redactJsonLine` before write, so a planted credential in any string field
   *  (tool output, message content, args) never reaches the ledger. `redactJsonLine` redacts the
   *  decoded string values and re-serializes, so the redacted line is ALWAYS one valid JSON event —
   *  even when a secret abuts a JSON escape (F1 integrity, structured-redaction regression: redacting the serialized string
   *  directly could split an escaped `\n` and produce a line a strict parser silently drops).
   *
   *  The redacted line is then **re-validated against the event schema** before it is written; if
   *  redaction left a schema-validated field invalid, append throws
   *  {@link SessionRedactionConflictError} and writes nothing (fail closed, loud at write time)
   *  rather than planting a line every future read would reject as corrupt. */
  append(event: SessionEventT): void {
    const redacted = redactJsonLine(JSON.stringify(SessionEvent.parse(event)));
    // Fail closed before any byte reaches the ledger — see SessionRedactionConflictError.
    const reparse = SessionEvent.safeParse(JSON.parse(redacted));
    if (!reparse.success) {
      const issue = reparse.error.issues[0];
      const where = issue === undefined ? "unknown field" : issue.path.join(".");
      throw new SessionRedactionConflictError(
        `refusing to append ${event.type} event: SEC-014 redaction left field ${JSON.stringify(where)} schema-invalid — the value looks like a high-entropy secret (a 44+ char token run) and was replaced with a redaction marker the field's schema rejects. Nothing was written; the session ledger is still valid and resumable. Benign identifiers must stay under ENTROPY_NET_MIN_TOKEN_CHARS (ledger-safe-id invariant, @keel/shared secrets/redact.ts).`,
      );
    }
    const line = Buffer.from(redacted + "\n", "utf8");
    let off = 0;
    while (off < line.length) off += writeSync(this.fd, line, off, line.length - off);
    fsyncSync(this.fd);
  }

  /** Release the write fd. Appending after this throws. */
  close(): void {
    closeSync(this.fd);
  }
}

/** Read a session ledger by id from the keel sessions dir. */
export function readSession(id: string, env: NodeJS.ProcessEnv = process.env): SessionFile {
  return readSessionFile(sessionPath(id, env));
}

/**
 * Tolerant reader: a torn/invalid *final* line is dropped (at most the last event is
 * lost — a crash mid-append); any corrupt *non-final* line throws `SessionCorruptError`
 * ("the file is never corrupt beyond the final line"). The first event must be the
 * session_meta header.
 */
export function readSessionFile(path: string): SessionFile {
  const content = readFileSync(path, "utf8");
  const endsWithNewline = content === "" || content.endsWith("\n");
  const raw = content.split("\n");
  const lines = endsWithNewline ? raw.slice(0, -1) : raw;

  const events: SessionEventT[] = [];
  for (let i = 0; i < lines.length; i++) {
    const torn = i === lines.length - 1 && !endsWithNewline;
    try {
      const parsed: unknown = JSON.parse(lines[i]!);
      // A newer keel's event (higher `v` / unknown `type`) is an honest upgrade case, not corruption
      // (ADR-0072 §4). Gate a COMPLETE line before the tolerant parse; a torn final line is dropped
      // regardless (an incomplete write is not a version signal).
      const reason = torn ? undefined : newerKeelReason(parsed, path);
      if (reason !== undefined) throw new SessionNewerVersionError(reason);
      // Tolerant parse (ADR-0072 §1): an unknown additive field on a known v:1 event is retained,
      // not fatal; a `v` mismatch or a malformed known field still fails and is reported corrupt.
      events.push(SessionEventTolerant.parse(parsed));
    } catch (err) {
      if (err instanceof SessionNewerVersionError) throw err; // honest upgrade — never "corrupt"
      if (torn) break; // crash mid-append: drop the torn final line
      throw new SessionCorruptError(`corrupt session line ${i} in ${path}: ${String(err)}`);
    }
  }

  const meta = events[0];
  if (meta === undefined || meta.type !== "session_meta") {
    throw new SessionCorruptError(`session ${path} is missing its session_meta header`);
  }
  return { meta, events: events.slice(1) };
}
