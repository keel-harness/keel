import type { Sha256T } from "../common/formats.js";
import type { JsonValueT } from "../common/json.js";
import type { AnyAuditRecordT } from "./record.js";
import { GENESIS_PREV_HASH, hashAuditRecord } from "./hash.js";

/**
 * The minimal structural shape `verifyChain` needs. Kept independent of the full
 * Appendix B `AuditRecord` schema so the (Phase-2B) standalone offline verifier
 * can reuse this module with a tiny dependency surface — the only contract is the
 * chain spine (`seq`/`prevHash`/`hash`) over an otherwise JSON-safe record.
 */
export type ChainRecord = Record<string, JsonValueT> & {
  seq: number;
  prevHash: Sha256T;
  hash: Sha256T;
};

/** The current chain head: the last record's `{ seq, hash }`, or the genesis
 *  sentinel `{ seq: -1, hash: GENESIS_PREV_HASH }` when the log is empty. */
export interface ChainHead {
  seq: number;
  hash: Sha256T;
}

/** The class of integrity break, ordered by how the verifier reports it. */
export type ChainFaultKind =
  | "genesis_mismatch" // first record's prevHash is not the genesis sentinel
  | "seq_discontinuity" // seq is not the 0-based, +1-monotonic position (gap, dup, reorder, bad start)
  | "chain_break" // prevHash does not equal the prior record's hash (delete/splice/relink)
  | "hash_mismatch" // stored hash does not equal the recomputed content hash (byte flip / forgery)
  | "truncated" // the chain is internally valid but shorter than the expected head (tail removed)
  | "head_mismatch"; // the chain reaches a head that is not the expected one (extension / forged tail)

export type ChainDiagnosis =
  // On success, `head` is the last record's `{ seq, hash }`, or `{ seq: -1, hash:
  // GENESIS_PREV_HASH }` for an empty log — use `seq === -1` (not the hash) to detect empty.
  | { ok: true; count: number; head: ChainHead }
  | { ok: false; kind: ChainFaultKind; seq: number; detail: string };

/** Options for {@link verifyChain}. */
export interface VerifyChainOptions {
  /**
   * The head the chain is expected to reach (for example, the warden's persisted
   * head or another out-of-band head/count anchor). When provided, the verifier
   * ALSO detects **tail truncation** and unexpected extension. A pure hash chain
   * read from a file in isolation cannot detect that records were removed from
   * the end — truncation detection is fundamentally **anchor-gated** (SEC-008).
   * In-bundle Phase-2B checkpoints prove the ranges they cover; they do not by
   * themselves prove no later checkpoint or record was omitted from the bundle.
   */
  expectedHead?: ChainHead;
}

/**
 * Verify a hash-chained audit log (Appendix B / SEC-008). For each record in
 * order it checks, in this precedence:
 *
 *   1. **seq continuity** — record `i` must have `seq === i` (0-based, +1
 *      monotonic). Catches deletion, reordering, duplication, and a bad start.
 *   2. **linkage** — record 0's `prevHash` must be the genesis sentinel; every
 *      later record's `prevHash` must equal the prior record's `hash`. Catches
 *      relinking and splicing in foreign records.
 *   3. **integrity** — the stored `hash` must equal the SHA-256 recomputed over
 *      the record's canonical JSON (sans hash/sig). Catches any field mutation.
 *
 * Then, IF `opts.expectedHead` is supplied, it checks the chain reaches that head
 * (catches **tail truncation** and forged extension — see {@link VerifyChainOptions}).
 *
 * An empty log is valid and reports the genesis head (`seq: -1`). The first fault
 * found is returned with its class and the offending `seq`, so a caller (and the
 * future `keel audit verify`) can render a precise one-line diagnosis.
 */
export function verifyChain(
  records: readonly ChainRecord[],
  opts?: VerifyChainOptions,
): ChainDiagnosis {
  let prevHash: Sha256T = GENESIS_PREV_HASH;
  let i = 0;

  for (const record of records) {
    if (record.seq !== i) {
      return {
        ok: false,
        kind: "seq_discontinuity",
        seq: record.seq,
        detail: `record at position ${i} has seq ${record.seq}, expected ${i}`,
      };
    }

    if (record.prevHash !== prevHash) {
      return i === 0
        ? {
            ok: false,
            kind: "genesis_mismatch",
            seq: 0,
            detail: `first record prevHash ${record.prevHash} is not the genesis sentinel`,
          }
        : {
            ok: false,
            kind: "chain_break",
            seq: record.seq,
            detail: `record ${record.seq} prevHash ${record.prevHash} does not link to the prior hash ${prevHash}`,
          };
    }

    const recomputed = hashAuditRecord(record);
    if (record.hash !== recomputed) {
      return {
        ok: false,
        kind: "hash_mismatch",
        seq: record.seq,
        detail: `record ${record.seq} stored hash does not match its content`,
      };
    }

    prevHash = record.hash;
    i++;
  }

  const last = records[records.length - 1];
  const head: ChainHead = last
    ? { seq: last.seq, hash: last.hash }
    : { seq: -1, hash: GENESIS_PREV_HASH };

  if (opts?.expectedHead) {
    const { seq: wantSeq, hash: wantHash } = opts.expectedHead;
    if (head.seq !== wantSeq || head.hash !== wantHash) {
      const kind: ChainFaultKind = head.seq < wantSeq ? "truncated" : "head_mismatch";
      return {
        ok: false,
        kind,
        seq: head.seq,
        detail: `chain head is seq ${head.seq} (${head.hash}); expected seq ${wantSeq} (${wantHash})`,
      };
    }
  }

  return { ok: true, count: records.length, head };
}

/**
 * Narrow full Appendix B records and Phase-2B checkpoint records to the structural
 * {@link ChainRecord} shape `verifyChain` consumes. An `AnyAuditRecordT` satisfies the chain spine
 * (`seq`/`prevHash`/`hash`) over JSON-safe fields, but the discriminated-union
 * type does not carry the `[k: string]: JsonValueT` index signature nominally —
 * so the (safe) widening is centralized here, documented, instead of cast at
 * every call site. The `AnyAuditRecordT` import is type-only (erased at runtime), so
 * the standalone verifier can still consume `verifyChain` without pulling the
 * full schema.
 */
export function toChainRecords(records: readonly AnyAuditRecordT[]): readonly ChainRecord[] {
  return records as unknown as readonly ChainRecord[];
}
