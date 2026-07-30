import {
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  openSync,
  readFileSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  AUDIT_SCHEMA_VERSION,
  AuditCheckpointRecord,
  type AuditCheckpointRecordT,
  AuditRecord,
  type AnyAuditRecordT,
  parseTolerantAuditRecord,
  type AuditEventTypeT,
  type AuditRecordT,
  type ChainDiagnosis,
  GENESIS_PREV_HASH,
  hashAuditRecord,
  type JsonObjectT,
  type JsonValueT,
  type PolicyPackRefT,
  type PrincipalT,
  publicKeyFromSecretKey,
  type RedactOptions,
  redactJsonKeysAndValues,
  type SessionIdT,
  type Sha256T,
  type SideEffectT,
  merkleRootForAuditHashes,
  signCheckpointRecord,
  toChainRecords,
  verifyChain,
} from "@keel/shared";

/** A record draft the warden hands the writer. The writer owns `seq`, `ts`,
 *  `principal`, `prevHash`, and `hash` — the caller never sets the chain spine.
 *  `policy`/`provenance` reuse the inferred Appendix B field types so the
 *  caller-facing contract is single-sourced with the schema. `checkpoint` is
 *  excluded: a (signed, Merkle-rooted) checkpoint is Phase-2B and is structurally
 *  not an appendable event here. */
export interface AuditAppendInput {
  eventType: Exclude<AuditEventTypeT, "checkpoint">;
  sessionId: SessionIdT;
  payload: JsonObjectT;
  /** REQUIRED on `tool.execute` / `tool.deny` (Appendix B); rejected-by-schema otherwise. */
  sideEffect?: SideEffectT;
  policyPack?: PolicyPackRefT;
  policy?: NonNullable<AuditRecordT["policy"]>;
  provenance?: NonNullable<AuditRecordT["provenance"]>;
}

/** What the rpc-server appends audit records through — either a single
 *  {@link AuditChainWriter} (one chain) or a `SessionAuditLog` (per-session chains).
 *  Both own the chain spine; the caller only supplies the draft. */
export interface AuditSink {
  append(input: AuditAppendInput): AuditRecordT;
  readonly head: { seq: number; hash: Sha256T };
  checkpointPublicKey(): Uint8Array | undefined;
  checkpointNow(sessionId?: SessionIdT): void;
  close(): void;
}

/**
 * The exact filesystem primitives {@link AuditChainWriter} uses on the durable append path.
 * Injectable so tests can drive short writes and mid-write ENOSPC deterministically; production
 * uses the real `node:fs` syncs. Only the append path is seamed — the lock path stays on real fs.
 */
export interface AuditWriterAppendIo {
  /** Append `data[offset .. offset+length)` to the (append-mode) fd; returns bytes written,
   *  which MAY be fewer than `length` (a short write — POSIX `write(2)` semantics). */
  writeSync(fd: number, data: Uint8Array, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  ftruncateSync(fd: number, len: number): void;
}

const REAL_APPEND_IO: AuditWriterAppendIo = {
  writeSync: (fd, data, offset, length) => writeSync(fd, data, offset, length),
  fsyncSync: (fd) => fsyncSync(fd),
  ftruncateSync: (fd, len) => ftruncateSync(fd, len),
};

export interface AuditChainWriterOptions {
  /** Append-only JSONL path (warden-owned; sandboxed tools have denyWrite here). */
  path: string;
  /** Who is acting — stamped on every record (Appendix B identity seam). */
  principal: PrincipalT;
  /** Active policy pack reference stamped on every new record when the caller does not provide one. */
  policyPack?: PolicyPackRefT;
  /** Injectable clock for deterministic tests. Default: wall-clock ISO 8601. */
  now?: () => string;
  /** Redaction options forwarded to the shared filter (default: full entropy net). */
  redactOptions?: RedactOptions;
  /**
   * Phase-2B checkpoint signing. When omitted, the writer preserves the legacy
   * hash-chain-only behavior. When present, invalid config fails before a writer
   * lock is acquired and checkpoints are emitted only by this writer, never by
   * caller-supplied append input.
   */
  checkpoint?: {
    /** Normal records between periodic checkpoints. Default: 128. */
    cadence?: number;
    /** Ed25519 32-byte secret key used to sign checkpoint hashes. */
    secretKey: Uint8Array;
  };
  /** Filesystem primitives for the durable append path. Default: real `node:fs`. */
  io?: AuditWriterAppendIo;
}

interface NormalizedCheckpointOptions {
  cadence: number;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

interface CheckpointCursor {
  rangeStartSeq: number;
  pendingHashes: Sha256T[];
  lastSessionId: SessionIdT | undefined;
}

/** Thrown by {@link AuditChainWriter.open} when the on-disk log is corrupt
 *  (interior blank/malformed line, or a chain-integrity fault). Carries the
 *  {@link ChainDiagnosis} when one is available so callers can `instanceof`-
 *  distinguish "audit corrupt" (fail closed) from a transient FS error (retry),
 *  and render a one-line reason — the basis for a future `keel audit verify`. */
export class AuditChainCorruptError extends Error {
  readonly diagnosis: ChainDiagnosis | undefined;
  constructor(message: string, diagnosis?: ChainDiagnosis) {
    super(message);
    this.name = "AuditChainCorruptError";
    this.diagnosis = diagnosis;
  }
}

export class AuditChainActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditChainActiveError";
  }
}

function lockPathFor(path: string): string {
  return `${path}.lock`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    return true;
  }
}

function staleLockPid(lockPath: string): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0
      ? raw.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function acquireLock(path: string): { path: string; fd: number } {
  const lockPath = lockPathFor(path);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, path })}\n`);
        fsyncSync(fd);
      } catch (error) {
        closeSync(fd);
        unlinkSync(lockPath);
        throw error;
      }
      return { path: lockPath, fd };
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        attempt > 0
      ) {
        throw error;
      }
      const pid = staleLockPid(lockPath);
      if (pid !== undefined && !processIsAlive(pid)) {
        unlinkSync(lockPath);
        continue;
      }
      throw new AuditChainActiveError(`audit chain at ${path} already has an active writer lock`);
    }
  }
  throw new AuditChainActiveError(`audit chain at ${path} already has an active writer lock`);
}

function releaseLock(lock: { path: string; fd: number }): void {
  closeSync(lock.fd);
  try {
    unlinkSync(lock.path);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

/** Parse the complete (newline-terminated) portion of a log into verified records,
 *  failing closed on an interior blank/malformed line or a chain-integrity break. */
function parseCompleteLog(complete: string, path: string): AnyAuditRecordT[] {
  const lines = complete.split("\n");
  // The trailing "" (from the final newline) is the expected artifact — drop it.
  if (lines[lines.length - 1] === "") lines.pop();

  const records: AnyAuditRecordT[] = [];
  for (const [pos, line] of lines.entries()) {
    if (line.length === 0) {
      throw new AuditChainCorruptError(
        `audit chain at ${path} is corrupt: blank line at record ${pos}`,
      );
    }
    try {
      // Tolerant read (ADR-0072 §1/§4): additive fields and novel eventTypes are retained + hashed,
      // not rejected; only a bad chain spine, a duplicate key, or a digest-excluded/prototype hiding
      // place fails here. Genuine corruption is still caught below by verifyChain over the raw bytes.
      records.push(parseTolerantAuditRecord(line));
    } catch (error) {
      // Surface the precise cause (duplicate key / forbidden key / bad spine) rather than a generic
      // "malformed" — all of these are corruption-class per ADR-0072 §4, but the reason is actionable.
      const reason = error instanceof Error ? error.message : String(error);
      throw new AuditChainCorruptError(
        `audit chain at ${path} is corrupt at record ${pos}: ${reason}`,
      );
    }
  }

  const diagnosis = verifyChain(toChainRecords(records));
  if (!diagnosis.ok) {
    throw new AuditChainCorruptError(
      `audit chain at ${path} is corrupt: ${diagnosis.kind} at seq ${diagnosis.seq} — ${diagnosis.detail}`,
      diagnosis,
    );
  }
  return records;
}

function normalizeCheckpointOptions(
  options: AuditChainWriterOptions["checkpoint"],
): NormalizedCheckpointOptions | undefined {
  if (options === undefined) return undefined;

  const cadence = options.cadence ?? 128;
  if (!Number.isInteger(cadence) || cadence < 1) {
    throw new RangeError("audit checkpoint cadence must be a positive integer");
  }

  const secretKey = options.secretKey;
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    throw new RangeError("audit checkpoint signing key must be a 32-byte Uint8Array");
  }

  try {
    publicKeyFromSecretKey(secretKey);
  } catch (error) {
    throw new RangeError("audit checkpoint signing key is not a valid Ed25519 secret key", {
      cause: error,
    });
  }

  return {
    cadence,
    secretKey: new Uint8Array(secretKey),
    publicKey: publicKeyFromSecretKey(secretKey),
  };
}

function checkpointCursorFor(records: readonly AnyAuditRecordT[]): CheckpointCursor {
  const cursor: CheckpointCursor = {
    rangeStartSeq: 0,
    pendingHashes: [],
    lastSessionId: undefined,
  };
  for (const record of records) {
    if (record.eventType === "checkpoint") {
      cursor.rangeStartSeq = record.seq + 1;
      cursor.pendingHashes = [];
      cursor.lastSessionId = undefined;
      continue;
    }
    cursor.pendingHashes.push(record.hash);
    cursor.lastSessionId = record.sessionId;
  }
  return cursor;
}

/**
 * Read + verify an existing audit log (read-only; takes NO writer lock, so it can
 * read a log an active writer still holds). Tolerates a torn final line (crash-safe)
 * by ignoring bytes after the last newline — it does NOT truncate (that is the
 * writer's job on `open`). Throws {@link AuditChainCorruptError} on an interior
 * blank/malformed line or a chain-integrity break. Used by the evidence-bundle
 * export (Epic 2.7) and the future `keel audit verify`.
 */
export function readAuditLog(path: string): AnyAuditRecordT[] {
  const buf = readFileSync(path);
  const completeLen = buf.lastIndexOf(0x0a) + 1;
  return parseCompleteLog(buf.subarray(0, completeLen).toString("utf8"), path);
}

/**
 * The warden-owned, append-only, SHA-256 hash-chained audit writer (Epic 2.6,
 * MASTER_SPEC §3.2(3), Appendix B). Each record links to the previous via
 * `prevHash`; the whole record is redacted *before* it is sealed, so the hash
 * commits to the redacted bytes. The agent never reaches this — it is constructed
 * inside the warden process; wiring it to `warden.audit.append` / `warden.execute`
 * is Epic 2.8.
 *
 * It is a class (not the warden's usual state-struct-threaded-through-functions
 * idiom) precisely so the append cursor (`seq`/`prevHash`) is encapsulated and a
 * caller cannot forge the chain spine.
 *
 * Single-writer by construction: one active `AuditChainWriter` owns a given path
 * via an exclusive lock file. A stale lock is removed only when its recorded PID
 * is no longer alive; otherwise the writer fails closed rather than risking two
 * append cursors.
 *
 * `open` is crash-safe: a torn final line (a crash mid-append, i.e. bytes after
 * the last newline) is dropped — the chain stays verifiable up to the last
 * complete record — and the torn bytes are truncated off disk so the next append
 * keeps the chain valid. "Complete" means newline-terminated; the writer always
 * emits `line + "\n"` in one fsync'd write, so the only incomplete line is a
 * crashed tail. Any OTHER fault (interior blank/malformed line, or a chain-
 * integrity break) makes `open` fail closed with {@link AuditChainCorruptError}.
 * `open` re-verifies the WHOLE chain (O(n)) — a deliberate fail-closed stance, not
 * to be "optimized" to a tail-only read (which would lose interior detection).
 */
export class AuditChainWriter {
  readonly #path: string;
  readonly #principal: PrincipalT;
  readonly #policyPack: PolicyPackRefT | undefined;
  readonly #now: () => string;
  readonly #redactOptions: RedactOptions | undefined;
  readonly #checkpoint: NormalizedCheckpointOptions | undefined;
  readonly #io: AuditWriterAppendIo;
  readonly #lock: { path: string; fd: number };
  #prevHash: Sha256T;
  #headSeq: number;
  #nextSeq: number;
  #checkpointRangeStartSeq: number;
  #pendingCheckpointHashes: Sha256T[];
  #lastSessionId: SessionIdT | undefined;
  #appendFd: number | undefined;
  /** Bytes of complete, durably-fsync'd records on disk — the truncate-back target if a partial
   *  write must be rolled off. Initialized to the log's complete length at open. */
  #durableBytes: number;
  #closed = false;
  /** Set when a durable append could not complete (short write we could not finish, or a
   *  write/fsync/rollback fault). A poisoned writer refuses further appends so it can never write a
   *  new record on top of a torn tail and corrupt the chain — it fails closed instead. */
  #poisoned = false;

  private constructor(
    options: AuditChainWriterOptions,
    head: { seq: number; prevHash: Sha256T },
    checkpoint: NormalizedCheckpointOptions | undefined,
    checkpointCursor: CheckpointCursor,
    lock: { path: string; fd: number },
    durableBytes: number,
  ) {
    this.#path = options.path;
    this.#principal = options.principal;
    this.#policyPack = options.policyPack;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#redactOptions = options.redactOptions;
    this.#checkpoint = checkpoint;
    this.#io = options.io ?? REAL_APPEND_IO;
    this.#lock = lock;
    this.#headSeq = head.seq;
    this.#prevHash = head.prevHash;
    this.#nextSeq = head.seq + 1;
    this.#checkpointRangeStartSeq = checkpointCursor.rangeStartSeq;
    this.#pendingCheckpointHashes = [...checkpointCursor.pendingHashes];
    this.#lastSessionId = checkpointCursor.lastSessionId;
    this.#durableBytes = durableBytes;
  }

  /** Open (or create-on-first-append) the chain at `path`, recovering the head. */
  static open(options: AuditChainWriterOptions): AuditChainWriter {
    const checkpoint = normalizeCheckpointOptions(options.checkpoint);
    const lock = acquireLock(options.path);
    if (!existsSync(options.path)) {
      return new AuditChainWriter(
        options,
        { seq: -1, prevHash: GENESIS_PREV_HASH },
        checkpoint,
        { rangeStartSeq: 0, pendingHashes: [], lastSessionId: undefined },
        lock,
        0,
      );
    }

    try {
      const buf = readFileSync(options.path);
      const completeLen = buf.lastIndexOf(0x0a) + 1;
      // Bytes after the last newline are a torn tail from a crashed append — truncate
      // them off disk (the writer fixes the file; readAuditLog leaves it untouched).
      if (buf.length > completeLen) {
        truncateSync(options.path, completeLen);
      }

      const records = parseCompleteLog(buf.subarray(0, completeLen).toString("utf8"), options.path);
      const last = records[records.length - 1];
      const head = last
        ? { seq: last.seq, prevHash: last.hash }
        : { seq: -1, prevHash: GENESIS_PREV_HASH };
      // completeLen = bytes of durable, newline-terminated records (post torn-tail truncation).
      return new AuditChainWriter(
        options,
        head,
        checkpoint,
        checkpointCursorFor(records),
        lock,
        completeLen,
      );
    } catch (error) {
      releaseLock(lock);
      throw error;
    }
  }

  /** The current chain head — the last record's `{ seq, hash }`, or the genesis
   *  sentinel `{ seq: -1, hash: GENESIS_PREV_HASH }` when empty (test `seq === -1`). */
  get head(): { seq: number; hash: Sha256T } {
    return { seq: this.#headSeq, hash: this.#prevHash };
  }

  /** True once a durable write failed: the writer rolled the file back to the last durable record
   *  and now refuses further appends. The on-disk chain is still valid up to that record, so a
   *  caller may evict this writer and reopen the path to resume the chain in-process (see
   *  {@link SessionAuditLog}) rather than wedging the session until the process restarts. */
  get poisoned(): boolean {
    return this.#poisoned;
  }

  checkpointPublicKey(): Uint8Array | undefined {
    return this.#checkpoint === undefined ? undefined : new Uint8Array(this.#checkpoint.publicKey);
  }

  checkpointNow(): void {
    if (this.#closed) throw new Error("cannot checkpoint a closed audit chain writer");
    if (this.#poisoned) {
      throw new Error(
        "cannot checkpoint a poisoned audit chain writer (a prior durable write failed)",
      );
    }
    this.#appendFinalCheckpointIfNeeded();
  }

  /** Redact, seal, and durably append one record; returns the written record. */
  append(input: AuditAppendInput): AuditRecordT {
    if (this.#closed) throw new Error("cannot append to a closed audit chain writer");
    if (this.#poisoned) {
      throw new Error(
        "cannot append to a poisoned audit chain writer (a prior durable write failed)",
      );
    }
    // Build the draft with a placeholder `hash` (any schema-valid Sha256 works —
    // it is stripped before hashing; GENESIS_PREV_HASH is reused only for its valid
    // shape, NOT as a genesis reference).
    const draft: Record<string, unknown> = {
      seq: this.#nextSeq,
      ts: this.#now(),
      sessionId: input.sessionId,
      principal: this.#principal,
      eventType: input.eventType,
      payload: input.payload,
      schemaVersion: AUDIT_SCHEMA_VERSION,
      prevHash: this.#prevHash,
      hash: GENESIS_PREV_HASH,
    };
    if (input.sideEffect !== undefined) draft["sideEffect"] = input.sideEffect;
    const policyPack = input.policyPack ?? this.#policyPack;
    if (policyPack !== undefined) {
      draft["policyPack"] = { packName: policyPack.name, packHash: policyPack.hash };
    }
    if (input.policy !== undefined) draft["policy"] = input.policy;
    if (input.provenance !== undefined) draft["provenance"] = input.provenance;

    // Redact EVERY string leaf AND every object KEY (not just values) before sealing, so a secret in
    // any field — payload args values OR a model-controlled `args` KEY (QC §6), sideEffect target
    // values / classifier reasons — is removed before the bytes are hashed and written. Keys are
    // redacted with the format catalog only (entropy net off), so the chain-spine fields
    // (prevHash/placeholder-hash = sha256 hex, sessionId = ULID, packHash = sha256 hex) and benign
    // high-entropy id keys are spared and the chain stays intact.
    const redacted = redactJsonKeysAndValues(draft, this.#redactOptions) as Record<
      string,
      JsonValueT
    >;

    // Parse BEFORE hashing: AuditRecord.parse runs the SideEffect canonicalizing
    // transform (sort+dedup of set-like arrays), so the hash must commit to the
    // post-transform bytes. The verifier recomputes over those same stored bytes,
    // and re-parsing is idempotent — so a reopened record always re-hashes equal.
    const canonical = AuditRecord.parse(redacted);
    const hash = hashAuditRecord(canonical as unknown as Record<string, JsonValueT>);
    const record = { ...canonical, hash };

    this.#appendLine(`${JSON.stringify(record)}\n`);

    this.#prevHash = hash;
    this.#headSeq = record.seq;
    this.#nextSeq = record.seq + 1;
    this.#pendingCheckpointHashes.push(hash);
    this.#lastSessionId = record.sessionId;
    this.#appendCheckpointIfDue();
    return record;
  }

  #appendCheckpointIfDue(): void {
    if (this.#checkpoint === undefined) return;
    if (this.#pendingCheckpointHashes.length < this.#checkpoint.cadence) return;
    this.#appendCheckpoint();
  }

  #appendFinalCheckpointIfNeeded(): void {
    if (this.#checkpoint === undefined) return;
    if (this.#pendingCheckpointHashes.length === 0) return;
    this.#appendCheckpoint();
  }

  #appendCheckpoint(): AuditCheckpointRecordT {
    if (this.#lastSessionId === undefined || this.#pendingCheckpointHashes.length === 0) {
      throw new Error("cannot append audit checkpoint without covered records");
    }

    const rangeEndSeq = this.#nextSeq - 1;
    const draft = AuditCheckpointRecord.parse({
      seq: this.#nextSeq,
      ts: this.#now(),
      sessionId: this.#lastSessionId,
      principal: this.#principal,
      eventType: "checkpoint",
      payload: {},
      ...(this.#policyPack === undefined
        ? {}
        : { policyPack: { packName: this.#policyPack.name, packHash: this.#policyPack.hash } }),
      schemaVersion: AUDIT_SCHEMA_VERSION,
      prevHash: this.#prevHash,
      hash: GENESIS_PREV_HASH,
      merkleRoot: merkleRootForAuditHashes(this.#pendingCheckpointHashes),
      range: [this.#checkpointRangeStartSeq, rangeEndSeq],
      sig: `ed25519:${"A".repeat(86)}==`,
    });

    const checkpoint = signCheckpointRecord(draft, this.#checkpoint!.secretKey);
    this.#appendLine(`${JSON.stringify(checkpoint)}\n`);

    this.#prevHash = checkpoint.hash;
    this.#headSeq = checkpoint.seq;
    this.#nextSeq = checkpoint.seq + 1;
    this.#checkpointRangeStartSeq = checkpoint.seq + 1;
    this.#pendingCheckpointHashes = [];
    return checkpoint;
  }

  /** One durable, fsync'd append. The writer keeps the append fd open after the first record; this
   *  preserves per-record durability while avoiding open/close overhead on hot audit paths.
   *
   *  Durability is all-or-nothing per record: the whole line is written in a loop (POSIX `write(2)`
   *  may write fewer bytes than requested — a "short write" — so a single unchecked `writeSync`
   *  could silently drop the tail of a record), then fsync'd. If ANY step faults (a short write we
   *  cannot finish, a write error, or an fsync error — e.g. a disk filling up), we roll the file
   *  back to the last durable record so no partial line survives, and POISON the writer: a partial
   *  tail plus a later append would concatenate into an interior malformed line and make the whole
   *  session's chain permanently unverifiable. Failing closed keeps the chain valid up to the last
   *  good record; a fresh writer can reopen and resume it. */
  #appendLine(line: string): void {
    const fd = this.#appendFd ?? openSync(this.#path, "a");
    this.#appendFd = fd;
    const buf = Buffer.from(line, "utf8");
    try {
      let written = 0;
      while (written < buf.length) {
        const n = this.#io.writeSync(fd, buf, written, buf.length - written);
        // A non-advancing write would spin forever; treat it as a fault and fail closed.
        if (n <= 0) throw new Error(`audit append made no progress (write returned ${String(n)})`);
        written += n;
      }
      this.#io.fsyncSync(fd);
    } catch (error) {
      this.#rollBackAndPoison();
      throw error;
    }
    this.#durableBytes += buf.length;
  }

  /** Truncate any partial bytes from the in-flight record back to the last durable record, then
   *  refuse all further appends. Best-effort truncation: even if it faults (e.g. still ENOSPC), the
   *  poison flag guarantees we never append on top of a possibly-torn tail. */
  #rollBackAndPoison(): void {
    this.#poisoned = true;
    if (this.#appendFd === undefined) return;
    try {
      this.#io.ftruncateSync(this.#appendFd, this.#durableBytes);
      this.#io.fsyncSync(this.#appendFd);
    } catch {
      // Nothing more we can safely do; the writer stays poisoned (fails closed).
    }
  }

  close(): void {
    if (this.#closed) return;
    try {
      // A poisoned writer must not attempt any further write (including a closing checkpoint) — it
      // just releases its handles so a fresh writer can reopen the intact chain.
      if (!this.#poisoned) this.#appendFinalCheckpointIfNeeded();
      if (this.#appendFd !== undefined) {
        closeSync(this.#appendFd);
        this.#appendFd = undefined;
      }
    } finally {
      this.#closed = true;
      releaseLock(this.#lock);
    }
  }
}
