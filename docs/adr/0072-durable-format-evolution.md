# ADR-0072 — Durable on-disk format evolution policy (tolerant readers + golden vectors)

**Status:** Accepted (2026-07-15). Maintainer approved the recommended policy, the additive
audit `schemaVersion` field, and the audit+session+golden-vectors scope, after a two-agent
research pass. This ADR is a **stop-and-ask** decision — it touches the frozen Appendix B audit
format, the SEC-008 tamper-evidence claim, and public on-disk contracts external forks will pin
at v1 — so it is recorded before code and governs the public format-evolution tests.
**Date:** 2026-07-15

**Amended 2026-07-16 (pre-Slice-2 adversarial review, maintainer-approved):** §2 hardened from two
to four normative invariants after three independent review passes found that tolerance re-opens
the digest-excluded keys `{hash, sig}` and the prototype key `__proto__` as un-hashed hiding places
(both confirmed reproducible); §4 clarified so an unknown `eventType` is integrity-verified and
treated as opaque (never "corrupt", never fail-open) and the audit chain builds no unreachable
"cannot-interpret" flag channel in v1; §6 elevated the vendored `verify-bundle.mjs` to required
lockstep (goldens-through-`.mjs` + the same §2 hardening). No decision reversed; the change
strengthens the invariants and the test obligations.

## Context

keel persists several durable on-disk formats. Their schemas are zod `.strict()` with fixed
version literals, so a file written by a **newer** keel is read by an **older** keel as
**corrupt**. This is a launch-blocking hazard for an open-source project: external forks will
build on the v1 formats, and "add one optional field → every older keel calls the ledger
corrupt" calcifies the format the moment anyone forks it (P1-12).

Two failure regimes exist today (verified against zod 3.25.76):

- **Fail-HARD (bricks) — the security/continuity-critical formats:**
  - **Session ledger** (`packages/shared/src/session/events.ts`) — every event `.strict()`,
    each carries `v: z.literal(1)` (ADR-0008), but **no reader ever branches on `v`**. An
    unknown field or `v:2` → `SessionCorruptError` (`kernel/src/session/store.ts:147`) → resume/
    continue fatal; `list` silently drops the whole session.
  - **Audit chain** (`packages/shared/src/audit/record.ts`) — `AnyAuditRecord`, all `.strict()`,
    and **no version field at all**. An unknown field or unknown `eventType` →
    `AuditChainCorruptError` (`warden/src/audit/writer.ts:237`); `keel audit verify` rejects the
    bundle (`kernel/src/audit/verify-bundle.ts:77`).
  - The **evidence-bundle envelope** and the **credential-proxy project config** hard-fail on a
    higher version too.
- **Fail-SOFT (graceful, lossy):** `trust.json`, the command/egress grant stores, and the
  autopilot mode store use `safeParse` → read-as-empty on any parse failure. Safe (re-prompt /
  re-grant / default Guided) but silently discards a newer keel's data.

**The decisive enabler.** `hashAuditRecord` (`audit/hash.ts`) hashes the RFC-8785 canonical JSON
over **every** field except `hash`/`sig` (it iterates `Object.entries`). So a **tolerant**
reader that recomputes the hash over the *raw parsed object* commits unknown/future fields to the
digest — an older keel can therefore verify a newer record's chain integrity + checkpoint
signature **without understanding the new fields**. The shipped standalone `verify-bundle.mjs`
(`warden/src/audit/bundle.ts` `verifierScriptSource`) already works exactly this way (no zod;
chain-spine + hash over all fields). Only the *in-process* warden/kernel readers are strict and
brick. The fix is to bring the in-process readers to the tolerance the artifact keel already
ships — not the reverse.

**What the existing ADRs already anticipated but did not implement.** ADR-0012 defines a
MINOR/MAJOR versioning policy and a "recognized-set + forward-tolerant wire" pattern, but is
scoped to the **ephemeral RPC wire** only. ADR-0006 froze the audit format + JCS canonicalizer
and states "any change after the first real audit record is written requires a migration and a
new audit schema version" — yet **no schema-version field exists on audit records**, and there
is **no committed full-record golden hash vector** (only `hash.test.ts` algorithm-property
tests), so a silent change to canonicalization/hashing would not be caught as the MAJOR break it
is. ADR-0008 says "the JSONL schema version must be included in every record so future readers
can handle format evolution" — the `v:1` field is present but no reader honors it.

## Decision

Establish a durable on-disk format evolution policy for keel, extending ADR-0012's tiers from
the wire to disk.

### 1. Tolerant "must-ignore-unknown-fields" readers for durable formats

Durable readers validate the **load-bearing spine + known discriminant strictly** and treat the
rest as passthrough (`JsonValue`), rather than rejecting the whole record on an unknown field.
Concretely, replace `.strict()` on the *read* path with retain-and-tolerate; an additive field a
reader does not understand is ignored, not fatal.

### 2. NORMATIVE invariants for the tamper-evident audit chain

Passthrough is safe for the audit chain **only** under these rules, which the ADR makes binding
(a naïve tolerant reader that violates them would convert forward-compat into a tamper hole). A
pre-implementation adversarial review (three independent passes, 2026-07-16) confirmed the first
two are necessary but **not sufficient** — tolerance re-opens digest-excluded keys as hiding
places — and added the third and fourth. All four are binding for any tolerant audit reader.

- **Hash the raw parsed object over all keys; the object handed to `hashAuditRecord`/`verifyChain`
  is always the raw parse, never a zod-transformed or re-serialized value.** zod's default
  `.strip()` drops unknown fields → the recomputed hash would omit a field the writer committed →
  a false `hash_mismatch`. Two consequences: (a) validate with `.catchall(JsonValue)` (retain +
  keep the `JsonObject` element constraint), never bare `.passthrough()` and never `.strict()`;
  (b) the read-path zod parse is a **validation gate only** — its output is never hashed. In
  particular the `SideEffect` canonicalizing transform (sort/dedup, derived `targets`) must NEVER
  run on the object that flows into the digest: the writer already persisted post-transform bytes,
  so hashing the raw on-disk parse reproduces the committed digest, whereas re-running the
  transform on a non-fixpoint (foreign/newer) record would mutate arrays and forge a false
  `hash_mismatch`. `parseSideEffectCompat` (ADR-0024) may run for *interpretation*, never for
  *integrity*.
- **Reject duplicate JSON object keys, recursively.** `JSON.parse` silently keeps the last of a
  duplicate key, a parse-confusion vector that lets a keep-first external verifier hash a
  different byte-image than keel's keep-last readers. Duplicate keys at **any** nesting depth are a
  hard parse failure, not a tolerated novelty. Because a `JSON.parse` reviver runs *after* the
  collapse, detection requires a lexical scan of the raw line, not a reviver.
- **The tolerated-unknown-key set MUST be disjoint from the digest-excluded set `{hash, sig}`.**
  `hashAuditRecord` omits top-level `hash` and `sig` from the digest by name. Under `.strict()`
  these could never arrive as extras; under tolerance they can — so a top-level `sig` on a
  non-checkpoint record (where `sig` is not a schema field) would be **retained by the reader yet
  excluded from the hash**, an un-hashed hiding place in which an attacker parks content that still
  verifies. Therefore: `hash` is a required, strictly-validated spine field on every record; `sig`
  is legitimate **only** on checkpoint records and MUST be rejected as an extra on any other kind;
  no digest-excluded key is ever a tolerated novelty.
- **Close the top-level `__proto__` digest hole: build the digest accumulator with a null
  prototype, and reject the prototype-pollution keys `__proto__`/`constructor`/`prototype` as
  TOP-LEVEL record keys.** `hashAuditRecord` accumulates its committed image with
  `committed[key] = value`; for a top-level `__proto__` key this invokes the inherited `__proto__`
  **setter** instead of creating an own key, so the field vanishes from `Object.entries` and is
  silently omitted from the digest — a confirmed un-hashed hiding place that `.strict()` closes
  today only by rejecting the key outright. The structural fix is to build the accumulator with
  `Object.create(null)` so such a key becomes a normal own data key that IS hashed (behavior-
  identical for every real record — none contain these keys — so the golden vectors stay
  byte-for-byte green and are the guard). Belt-and-suspenders, the reader also rejects these three
  names as **top-level** record keys, where they are never a legitimate audit field. Scope matters:
  the rejection is **top-level only**, NOT recursive — a `payload` is model-controlled JSON that may
  legitimately carry a key named `constructor`, and a **nested** `__proto__` is already correctly
  hashed (`canonicalize` recurses via `Object.entries` with no accumulator assignment, so it is
  committed, not dropped). Rejecting these names recursively would brick a legitimate record; the
  top-level scope closes the only real hole without that hazard.

The `JsonObject` constraint (no `NaN`/`undefined`/`±Infinity`/`-0`) stays on every field, known and
tolerated. Handling of a new **discriminant value** (a new `eventType`) is specified in §4: for the
audit chain it is integrity-verified and treated as opaque, never silently interpreted and never
reported as corrupt.

### 3. Version tiers (extending ADR-0012 to on-disk formats)

| Change to a durable format | Tier |
|---|---|
| Additive **optional** field on an existing record | MINOR — tolerant readers absorb it; no migration |
| New **event type** / record variant | MINOR for readers that only verify integrity (audit chain still verifies); MAJOR for readers that must interpret it |
| Removing/renaming a field; changing a field's type or meaning; making a field required | MAJOR — own ADR + version bump |
| **Any** change to canonicalization, the hash/sig construction, or the Merkle scheme | MAJOR — invalidates every prior record + every golden vector (ADR-0006) |

**No migration function ships in v1.** A tolerant reader + an honest higher-version refusal
covers every additive case. A migration is only ever needed for a MAJOR on-disk rewrite, which is
gated behind its own ADR. Smallest slice that makes the claim true (AGENTS.md simplicity gate).

### 4. Higher version → honest refusal, never "corrupt"

An older reader meeting a format version it does not recognize must emit an honest, typed **"this
{session/bundle} was written by a newer keel (schema v{n}); upgrade keel to read it"** — never
the tamper/corruption vocabulary. Per format:

- **Session ledger:** on an unrecognized higher `v`, refuse resume (or skip the event) with the
  honest upgrade message; do not throw `SessionCorruptError`.
- **Audit chain:** an integrity-only reader **tolerates** additive novelty and reports honestly on
  integrity — it never emits the corruption vocabulary for mere novelty, and it never fails open.
  Concretely, resolving the §2↔§4 tension the review surfaced (§2 "an unknown discriminant must
  fail honestly" vs the §3 tier "new event type = MINOR for integrity-only readers"):
  - An **unknown top-level/nested field** on a known record: retained, hashed, chain-verified. No
    flag; it is indistinguishable from any additive MINOR field.
  - An **unknown `eventType`** (a record variant a newer keel introduced) with a valid chain
    spine: **integrity-verified** (its hash covers all its fields, its `prevHash` links) and
    treated as an **opaque non-checkpoint record** — it is not `"checkpoint"`, so it never
    masquerades as a signed checkpoint, and it is never silently interpreted as a known record.
    It is NOT reported as corrupt. This is the §3-tier behavior: an integrity-only reader (which
    keel's audit readers are) does not need to interpret a record to verify the chain. Only a
    reader that must *interpret* a record (not keel's audit verifier in v1) fails honestly on an
    unknown discriminant — that is what §2's "fail honestly" scopes to.
  - A **higher `schemaVersion`** (§5): tolerated exactly like any additive field — there is **no
    recognized-set to branch on and no separate "cannot-interpret" flag channel built in v1** (a
    flag surface with no consumer would be scope creep and an uncoverable branch). Crucially,
    `schemaVersion`-awareness must sit **around/after** `verifyChain`, never as a pre-check that
    could short-circuit integrity — a higher version must never cause the reader to skip the hash
    check and report `ok:true` (the fail-open a denied-path test pins: a higher-`schemaVersion`
    chain with a tampered byte still returns `hash_mismatch`).
  - **Genuine corruption stays corrupt:** an invalid chain spine (bad `seq`/`prevHash`/`hash`
    shape), a duplicate or prototype key (§2), a broken hash/link, or a `sig` on a non-checkpoint
    record fails closed with the corruption vocabulary. Tolerant ≠ credulous.
- **Evidence bundle / credential-proxy:** keep the existing fail-closed envelope-version check but
  change the message to the honest upgrade line. (The bundle envelope version — distinct from a
  record's `schemaVersion` — is a recognized-set the reader *does* branch on, so the honest-upgrade
  refusal applies there, as it does to the session ledger `v`.)

### 5. Audit records gain an additive-optional `schemaVersion`

Audit records currently have no version field. Add `schemaVersion` (or `v`) as an
**additive-optional, hash-committed** field, symmetric with the session ledger's `v:1` and
enabling future MAJOR detection (ADR-0006's anticipated "audit schema version"). Mechanics that
the ADR pins:

- It is a MINOR (additive-optional) change: an old reader (tolerant) ignores it; a new reader
  tolerates its absence on legacy records.
- Because it is hash-committed, it changes the hash of **newly written** records only — it does
  **not** alter or invalidate any already-written record (their bytes are frozen on disk). The
  golden-vector set gains new with-`schemaVersion` vectors; the existing (no-`schemaVersion`)
  vectors stay valid and continue to lock legacy-record verification.
- It is mirrored into the checkpoint record shape (the hand-copied base fields, `record.ts:104`),
  and a drift guard is added so the two record branches cannot silently diverge.

### 6. Committed golden vectors as the frozen anchor

Commit full-record known-answer vectors — a realistic `tool.execute` `AuditRecord`, a minimal
`session.start` record, an `AuditCheckpointRecord` (pinned hash + `merkleRoot` + a deterministic
Ed25519 `sig` under a fixed test key), and a small multi-record **chain head** — each pinned to
its exact `sha256:` digest. These lock the canonicalization + hash + sig + Merkle pipeline: any
silent change is caught by CI as the MAJOR break it is. Changing a golden vector is itself a
MAJOR bump requiring this ADR's update.

The shipped standalone `verify-bundle.mjs` (`warden/src/audit/bundle.ts` `verifierScriptSource`)
is the **auditor-facing** verifier and a second, independent re-implementation of the
canonicalize/hash/Merkle pipeline. It is **required** (not "ideally") to stay in lockstep with the
in-process readers, enforced two ways:

- **(a) Digest-pipeline lock (transitive to the golden vectors).** Parity tests that `spawn` the
  real generated `.mjs` on a bundle built from records **sealed by the shared pipeline** assert the
  `.mjs` prints `OK <rootHash>` equal to the shared `verifyChain` head. Because those records carry
  shared-computed hashes/Merkle roots, ANY drift in the `.mjs` `canonicalize`/`hashAuditRecord`/
  `merkleRoot` makes its recompute diverge and the spawn test fail. The golden vectors pin the
  shared pipeline to exact digests; the parity tests pin the `.mjs` to the shared pipeline — so the
  `.mjs` is transitively locked to the golden digests, without a second hand-maintained copy of the
  pinned constants.
- **(b) Rejection lock.** The §2 hardening (recursive dup-key + prototype-key rejection, null-
  prototype digest accumulator, `sig`-on-non-checkpoint rejection, spine-shape checks) lands in the
  `.mjs` too, with `spawn` parity tests proving identical verdicts on the crafted hiding-place
  inputs. A more-permissive shipped verifier than keel's own would be a tamper-evidence regression
  an external auditor could not see.

**Accepted leniency delta (non-security):** the `.mjs` performs spine-SHAPE checks but not the full
`JsonValue`/format refinement the in-process `.catchall(JsonValue)` gate applies — e.g. a `-0` leaf,
or a `ts`/`sessionId` that is a string but not ISO/ULID, is accepted by the `.mjs` and rejected in
process. These are never hiding places (fully hash-covered) and never occur in a keel-written record
(the write path rejects them), and both readers canonicalize/hash them identically, so the delta
cannot mask tampering; it is recorded here rather than eliminated to keep the vendored verifier
small.

### 7. Scope of the v1 fix

- **In scope:** the two hard-fail security/continuity formats — the **audit chain** and the
  **session ledger** — get tolerant readers + honest higher-version handling; the **golden
  vectors** land; audit records get `schemaVersion`.
- **Documented, not converted:** the fail-soft stores (`trust.json`, grant stores, mode store)
  are recorded as **acceptable-with-silent-loss** (they fail closed to empty — re-prompt/re-grant/
  default; no bricking, no security regression). The evidence-bundle envelope and credential-proxy
  config get the **honest upgrade message** wording. Converting the fail-soft stores to the full
  tolerant/tolerated pattern is a tracked follow-up, not launch-blocking.

## Consequences

- **Security-neutral, tamper-evidence preserved.** The audit chain's integrity comes from
  hash-over-all-fields + chain linkage + signed checkpoints, not from `.strict()`. Tolerant
  reading under the §2 invariants preserves every one of those. The proof is a **total
  tamper-detection property** with no carve-out — for any mutation of any byte of any on-disk
  record (add key, drop key, change value, add a digest-excluded `hash`/`sig` or a prototype key),
  the reader either fails to parse or `verifyChain` returns `ok:false` — plus explicit denied-path
  tests that the digest-excluded and prototype keys are *rejected* (not merely "hash-mismatched",
  which they cannot be), and that a checkpoint whose covered range includes a record with an
  unknown field still verifies end-to-end only because the reader hashed that field.
- **Public-behavior change (honest).** A newer-version durable file stops being reported as
  "corrupt" and becomes an honest "written by a newer keel; upgrade." Scripts/forks keying on the
  corruption vocabulary see a changed, more-honest surface — called out for review.
- **Forks can safely evolve v1.** Adding an optional field to a session event or audit record no
  longer bricks older keels; the golden vectors keep the hash pipeline honest across those forks.
- **Frozen-format touch.** Adding `schemaVersion` to Appendix B audit records + changing the
  in-process audit reader behind the SEC-008 claim required maintainer sign-off (recorded above).

## Related

- **Amends ADR-0006** (audit format) — makes the anticipated "audit schema version" concrete
  (`schemaVersion`) and adds the golden-vector freeze + the hash-over-raw-object invariant.
- **Implements ADR-0008** (session JSONL) — the "future readers handle evolution" clause via the
  tolerant reader + honest higher-version refusal.
- **Extends ADR-0012** (RPC protocol versioning) — same MINOR/MAJOR model, now for durable
  on-disk formats.
- **Follow-ups it creates:** convert the fail-soft stores (trust/grants/mode) to
  tolerant/honest-upgrade; wire the existing `parseSideEffectCompat` (ADR-0024) into the durable
  audit read path (today it is tested but never called on-disk); a checkpoint/record base-field
  drift guard if not landed in the epic; make the evidence-bundle **`checkpoints.json`** reader
  tolerant too — today `BundleCheckpoints` parses each checkpoint with the `.strict()`
  `AuditCheckpointRecord`, so a newer keel's additive field on a *checkpoint* record fails the bundle
  `artifact_invalid` even though the same field on `audit.jsonl` is tolerated (fail-closed, not a
  hole, but inconsistent with §4 forward-compat — fold into the evidence-bundle wording slice).
