import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AuditRecordT,
  GENESIS_PREV_HASH,
  type PrincipalT,
  publicKeyFromSecretKey,
  type RedactOptions,
  SessionId,
  type SessionIdT,
  type Sha256T,
} from "@keel/shared";
import {
  type AuditAppendInput,
  type AuditChainWriterOptions,
  type AuditSink,
  type AuditWriterAppendIo,
  AuditChainWriter,
} from "./writer.js";

/** The on-disk path for a session's audit chain under `auditDir`. Validates the id
 *  is a ULID before it becomes a filename — shared by {@link SessionAuditLog} and
 *  the evidence-bundle export so they cannot drift. */
export function sessionAuditLogPath(auditDir: string, sessionId: SessionIdT): string {
  if (!SessionId.safeParse(sessionId).success) {
    throw new Error(`invalid session id for audit log path: ${JSON.stringify(sessionId)}`);
  }
  return join(auditDir, `${sessionId}.jsonl`);
}

export interface SessionAuditLogOptions {
  /** Directory holding one `<sessionId>.jsonl` chain per session. */
  auditDir: string;
  /** Who is acting — stamped on every record (Appendix B identity seam). */
  principal: PrincipalT;
  /** Active policy pack reference stamped on every new record. */
  policyPack?: AuditChainWriterOptions["policyPack"];
  /** Injectable clock (deterministic tests). */
  now?: () => string;
  /** Redaction options forwarded to each per-session writer. */
  redactOptions?: RedactOptions;
  /** Phase-2B checkpoint signing options forwarded to each per-session writer. */
  checkpoint?: AuditChainWriterOptions["checkpoint"];
  /** Filesystem primitives for the durable append path, forwarded to each writer. Default: real fs. */
  io?: AuditWriterAppendIo;
}

/**
 * Per-session audit chains. Routes each `append` to a session-scoped
 * `<auditDir>/<sessionId>.jsonl` {@link AuditChainWriter}, opened lazily on first
 * use and cached. **Each session is its own complete, independently-verifiable hash
 * chain** — the topology the per-session evidence bundle (Epic 2.7) requires: a
 * process-wide chain across sessions cannot be sliced by `sessionId` without
 * breaking `verifyChain` (the `seq`/`prevHash` links would gap). The warden learns
 * the `sessionId` per-RPC (not at process start), which is why writers open lazily.
 *
 * Drop-in for the rpc-server's prior single-writer wiring: `append(input)` and
 * `head` keep the same shapes (`head` reports the most-recently-appended session).
 */
/**
 * Create (or repair) the audit directory as owner-only.
 *
 * The chain carries full command text, resolved paths, and model-authored tool args behind only
 * best-effort redaction, so it is at least as sensitive as the artifacts around it — the checkpoint
 * signing key is `0600` and rejects `mode & 0o077` on load, and `sessions/`/`snapshots/` are `0700`.
 * The records were the one exception, left at the process umask.
 *
 * `mkdir`'s `mode` alone is not enough: the KERNEL pre-creates this directory before spawning the
 * warden (`kernel/src/warden/runtime.ts`), so on every existing install the `mkdir` here is a no-op
 * and its mode is never applied. The explicit `chmod` is what actually converges the state. A
 * failure to tighten is not fatal — the chain and its lock still open, and an unwritable-mode
 * directory is the operator's to fix — but it must never silently pass as hardened, so the caller
 * keeps whatever the filesystem reports.
 */
function ensureOwnerOnlyAuditDir(auditDir: string): void {
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(auditDir, 0o700);
  } catch {
    // A directory keel does not own (an operator-supplied KEEL_WARDEN_AUDIT_DIR on a foreign mount)
    // may refuse chmod. Writing the chain is still correct; confidentiality is then the operator's.
  }
}

export class SessionAuditLog implements AuditSink {
  readonly #auditDir: string;
  readonly #principal: PrincipalT;
  readonly #policyPack: AuditChainWriterOptions["policyPack"] | undefined;
  readonly #now: (() => string) | undefined;
  readonly #redactOptions: RedactOptions | undefined;
  readonly #checkpoint: AuditChainWriterOptions["checkpoint"] | undefined;
  readonly #checkpointPublicKey: Uint8Array | undefined;
  readonly #io: AuditWriterAppendIo | undefined;
  readonly #writers = new Map<SessionIdT, AuditChainWriter>();
  #lastSessionId: SessionIdT | undefined;

  constructor(options: SessionAuditLogOptions) {
    this.#auditDir = options.auditDir;
    this.#principal = options.principal;
    this.#policyPack = options.policyPack;
    this.#now = options.now;
    this.#redactOptions = options.redactOptions;
    this.#checkpoint = options.checkpoint;
    this.#io = options.io;
    this.#checkpointPublicKey =
      options.checkpoint === undefined
        ? undefined
        : publicKeyFromSecretKey(options.checkpoint.secretKey);
  }

  /** The on-disk path for a session's audit chain. Validates the id is a ULID
   *  before it becomes a filename — defense in depth against a malformed id
   *  reaching the filesystem. */
  pathFor(sessionId: SessionIdT): string {
    return sessionAuditLogPath(this.#auditDir, sessionId);
  }

  #writerFor(sessionId: SessionIdT): AuditChainWriter {
    const cached = this.#writers.get(sessionId);
    if (cached !== undefined && !cached.poisoned) return cached;
    if (cached !== undefined) {
      // A prior durable write poisoned this writer; it already rolled the file back to the last
      // durable record, so the on-disk chain is valid. Evict it (releasing its lock) and reopen so
      // the session resumes in-process once the underlying fault clears — instead of every later
      // append/checkpoint/export for this session failing until the warden restarts. If the fault
      // persists, the reopened writer simply re-poisons on the next append (still fail-closed).
      cached.close();
      this.#writers.delete(sessionId);
    }
    const path = this.pathFor(sessionId);
    ensureOwnerOnlyAuditDir(this.#auditDir);
    const writer = AuditChainWriter.open({
      path,
      principal: this.#principal,
      ...(this.#policyPack === undefined ? {} : { policyPack: this.#policyPack }),
      ...(this.#now === undefined ? {} : { now: this.#now }),
      ...(this.#redactOptions === undefined ? {} : { redactOptions: this.#redactOptions }),
      ...(this.#checkpoint === undefined ? {} : { checkpoint: this.#checkpoint }),
      ...(this.#io === undefined ? {} : { io: this.#io }),
    });
    this.#writers.set(sessionId, writer);
    return writer;
  }

  /** Append a record to its session's chain (drop-in for `AuditChainWriter.append`). */
  append(input: AuditAppendInput): AuditRecordT {
    const record = this.#writerFor(input.sessionId).append(input);
    this.#lastSessionId = input.sessionId;
    return record;
  }

  /** Head of the most-recently-appended session, or the genesis sentinel
   *  (`{ seq: -1, hash: GENESIS_PREV_HASH }`) when nothing has been appended. */
  get head(): { seq: number; hash: Sha256T } {
    if (this.#lastSessionId === undefined) return { seq: -1, hash: GENESIS_PREV_HASH };
    // `#lastSessionId` is set only after a successful append, which leaves the writer
    // in the map (writers are removed only by close(), which clears #lastSessionId).
    return this.#writers.get(this.#lastSessionId)!.head;
  }

  checkpointPublicKey(): Uint8Array | undefined {
    return this.#checkpointPublicKey === undefined
      ? undefined
      : new Uint8Array(this.#checkpointPublicKey);
  }

  checkpointNow(sessionId?: SessionIdT): void {
    if (sessionId !== undefined) {
      this.#writerFor(sessionId).checkpointNow();
      return;
    }
    // Isolate per-session failures so one poisoned/failing session cannot silently skip checkpointing
    // the healthy remainder. Route through #writerFor so a poisoned session is evicted+reopened and
    // still gets checkpointed. Snapshot the keys — #writerFor may mutate the map.
    const errors: unknown[] = [];
    for (const id of [...this.#writers.keys()]) {
      try {
        this.#writerFor(id).checkpointNow();
      } catch (error) {
        errors.push(error);
      }
    }
    throwIfAny(errors, "checkpoint");
  }

  /** Close every open per-session writer (releases their exclusive locks). */
  close(): void {
    // Isolate per-writer failures so one throwing close cannot leak the other sessions' locks. Always
    // clear the map (the writers are done regardless), then surface any failure.
    const errors: unknown[] = [];
    for (const writer of this.#writers.values()) {
      try {
        writer.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#writers.clear();
    this.#lastSessionId = undefined;
    throwIfAny(errors, "close");
  }
}

/** Surface a batch of per-session audit failures without letting the first swallow the rest. */
function throwIfAny(errors: readonly unknown[], op: string): void {
  if (errors.length === 0) return;
  const first = errors[0];
  throw new Error(`audit ${op} failed for ${errors.length} session(s)`, { cause: first });
}
