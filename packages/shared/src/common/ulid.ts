import { randomFillSync } from "node:crypto";

/**
 * ULID generation for keel ids (`ses_<ULID>`, `mem_<ULID>` — see `formats.ts`).
 *
 * A ULID is 26 Crockford-base32 chars: a 48-bit millisecond timestamp (first 10
 * chars, MSB-first) followed by 80 bits of CSPRNG randomness (last 16 chars). Ids are
 * lexicographically sortable by time only to MILLISECOND granularity: the random suffix
 * has no within-ms monotonic counter, so two ids minted in the same millisecond have NO
 * defined relative order. Nothing security-relevant relies on their order — the audit
 * chain orders by `seq`, not by id (session/memory listing is the only consumer, and
 * tolerates same-ms ties). Dependency-free by design (AGENTS.md "no convenience
 * dependencies") — `crypto.randomFillSync` is the only primitive needed.
 *
 * Prefixed ULIDs sit at ~30 chars — safely below `ENTROPY_NET_MIN_TOKEN_CHARS` (44), so they
 * survive the SEC-014 redaction entropy net. Before minting a LONGER id format (or composing ids
 * into longer tokens), read the ledger-safe-id invariant in `secrets/redact.ts`.
 */

/** Crockford base32 alphabet (excludes I, L, O, U) — matches the `SessionId`/`MemId` regexes. */
const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode a 48-bit millisecond timestamp as 10 base32 chars, most-significant first. */
function encodeTime(ms: number): string {
  let out = "";
  let n = Math.floor(ms);
  for (let i = 0; i < 10; i++) {
    const mod = n % 32;
    out = ENC.charAt(mod) + out;
    n = (n - mod) / 32;
  }
  return out;
}

/** Encode 80 bits (10 CSPRNG bytes) as 16 base32 chars. */
function encodeRandom(): string {
  const bytes = randomFillSync(new Uint8Array(10));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = ENC.charAt(Number(n & 31n)) + out;
    n >>= 5n;
  }
  return out;
}

/** A 26-char Crockford-base32 ULID. `timeMs` is injectable for deterministic tests. */
export function ulid(timeMs: number = Date.now()): string {
  return encodeTime(timeMs) + encodeRandom();
}

/** A new session id (`ses_<ULID>`), satisfying `SessionId` in `formats.ts`. */
export const newSessionId = (): string => `ses_${ulid()}`;

/** A new memory id (`mem_<ULID>`), satisfying `MemId` in `formats.ts`. */
export const newMemId = (): string => `mem_${ulid()}`;
