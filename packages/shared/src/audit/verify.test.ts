import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { JsonValueT } from "../common/json.js";
import { GENESIS_PREV_HASH, hashAuditRecord } from "./hash.js";
import { type ChainRecord, verifyChain } from "./verify.js";

/** Seal a record draft (assign its content hash) the way the writer does. */
function seal(fields: Record<string, JsonValueT>): ChainRecord {
  return { ...fields, hash: hashAuditRecord(fields) } as ChainRecord;
}

/** Build a well-formed chain of `n` linked, sealed records. `sessionId`
 *  distinguishes otherwise-identical chains so a "foreign" chain has different
 *  content (and therefore different hashes) for the splice case. */
function buildChain(n: number, sessionId = "ses_x"): ChainRecord[] {
  const records: ChainRecord[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < n; i++) {
    const r = seal({
      seq: i,
      ts: "2026-06-26T14:00:00.000Z",
      sessionId,
      eventType: "tool.execute",
      payload: { i },
      prevHash,
    });
    records.push(r);
    prevHash = r.hash;
  }
  return records;
}

/** Deep clone so a mutation cannot leak across cases. */
function clone(records: ChainRecord[]): ChainRecord[] {
  return JSON.parse(JSON.stringify(records)) as ChainRecord[];
}

describe("verifyChain (SEC-008 tamper detection)", () => {
  it("accepts a well-formed chain and reports the head", () => {
    const chain = buildChain(5);
    const result = verifyChain(chain);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(5);
      expect(result.head).toEqual({ seq: 4, hash: chain[4]!.hash });
    }
  });

  it("accepts an empty chain (no records yet) with the genesis head", () => {
    const result = verifyChain([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(0);
      expect(result.head).toEqual({ seq: -1, hash: GENESIS_PREV_HASH });
    }
  });

  it("detects a tampered genesis prevHash", () => {
    const chain = clone(buildChain(3));
    chain[0]!.prevHash = `sha256:${"1".repeat(64)}`;
    const result = verifyChain(chain);
    expect(result).toMatchObject({ ok: false, kind: "genesis_mismatch", seq: 0 });
  });

  it("detects a flipped field (stored hash no longer matches content) as hash_mismatch", () => {
    const chain = clone(buildChain(4));
    // Mutate payload but keep the stale stored hash → integrity break, not linkage/seq.
    chain[2]!["payload"] = { i: 999 };
    const result = verifyChain(chain);
    expect(result).toMatchObject({ ok: false, kind: "hash_mismatch", seq: 2 });
  });

  it("detects a broken prevHash linkage (chain_break)", () => {
    const chain = clone(buildChain(4));
    // Re-seal record 2 with a wrong prevHash so its own hash stays self-consistent
    // (seq intact) but it no longer links to record 1. `seal` recomputes the hash
    // over the draft (stripping the stale one), so no manual delete is needed.
    const tampered: Record<string, JsonValueT> = {
      ...clone([chain[2]!])[0]!,
      prevHash: `sha256:${"2".repeat(64)}`,
    };
    chain[2] = seal(tampered);
    const result = verifyChain(chain);
    expect(result).toMatchObject({ ok: false, kind: "chain_break", seq: 2 });
  });

  it("detects a deleted record via seq discontinuity", () => {
    const chain = clone(buildChain(5));
    chain.splice(2, 1); // seqs become 0,1,3,4
    const result = verifyChain(chain);
    expect(result).toMatchObject({ ok: false, kind: "seq_discontinuity", seq: 3 });
  });

  it("detects reordered records via seq discontinuity", () => {
    const chain = clone(buildChain(5));
    [chain[1], chain[2]] = [chain[2]!, chain[1]!];
    const result = verifyChain(chain);
    expect(result).toMatchObject({ ok: false, kind: "seq_discontinuity" });
  });

  it("detects a duplicated seq", () => {
    const chain = clone(buildChain(4));
    chain[2] = clone([chain[1]!])[0]!; // two records claim seq 1
    const result = verifyChain(chain);
    expect(result).toMatchObject({ ok: false, kind: "seq_discontinuity", seq: 1 });
  });

  it("detects a record spliced in from a foreign chain (chain_break)", () => {
    const chain = clone(buildChain(5));
    const foreign = buildChain(5, "ses_foreign"); // independent chain, different hashes
    chain[2] = clone([foreign[2]!])[0]!; // foreign record also has seq 2 — seq passes, linkage fails
    const result = verifyChain(chain);
    expect(result).toMatchObject({ ok: false, kind: "chain_break", seq: 2 });
  });

  it("detects tail truncation when given the expected head (anchor-gated)", () => {
    const chain = buildChain(5);
    const expectedHead = { seq: 4, hash: chain[4]!.hash };
    const truncated = chain.slice(0, 3); // drop the last 2 records
    const result = verifyChain(truncated, { expectedHead });
    expect(result).toMatchObject({ ok: false, kind: "truncated", seq: 2 });
  });

  it("cannot detect tail truncation WITHOUT an anchor (documented 2A limitation)", () => {
    const chain = buildChain(5);
    const truncated = chain.slice(0, 3);
    // An internally-valid shorter chain verifies clean when no expectedHead is supplied.
    expect(verifyChain(truncated).ok).toBe(true);
  });

  it("accepts a chain that reaches the expected head", () => {
    const chain = buildChain(4);
    expect(verifyChain(chain, { expectedHead: { seq: 3, hash: chain[3]!.hash } }).ok).toBe(true);
  });

  it("flags a head mismatch when the chain reaches a head past the expected one", () => {
    const chain = buildChain(4);
    const result = verifyChain(chain, { expectedHead: { seq: 2, hash: chain[2]!.hash } });
    expect(result).toMatchObject({ ok: false, kind: "head_mismatch", seq: 3 });
  });

  it("detects a fully-truncated (empty) log against a non-genesis expected head", () => {
    const chain = buildChain(3);
    const result = verifyChain([], { expectedHead: { seq: 2, hash: chain[2]!.hash } });
    expect(result).toMatchObject({ ok: false, kind: "truncated", seq: -1 });
  });

  it("detects ANY single-field mutation (property — 100% detection)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0 }), (n, rawIdx) => {
        const chain = clone(buildChain(n));
        const idx = rawIdx % n;
        // Corrupt the payload without re-sealing → must never verify clean.
        chain[idx]!["payload"] = { mutated: true, idx };
        const result = verifyChain(chain);
        expect(result.ok).toBe(false);
      }),
    );
  });
});
