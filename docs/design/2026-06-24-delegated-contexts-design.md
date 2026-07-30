# Delegated Contexts (Subagents) — Design Spec & ADR-Ready Recommendation

**Status:** Design spec, pre-implementation. Defines the target architecture (Option B) and a
shippable first slice. **No code is written by this document.** It is meant to be reviewed by a
human and an independent LLM, and to be the source for the ADR amendments named in §Deliverable 2.
**Date:** 2026-06-24.
**Author:** drafted with Claude (Opus 4.8).
**Decision:** bounded delegated contexts with explicit authority and evidence constraints.
**Decision owner:** keel maintainer. Several points are explicit **stop-and-ask** gates (flagged).

---

## 0. Naming & framing (read first — it shapes everything)

keel does **not** adopt "multi-agent." It adopts **bounded delegated contexts**.

- **User-facing name:** "subagents" is acceptable in CLI/help/docs because it is familiar.
- **Design & code language:** prefer **"delegated context"** or **"scoped worker."** Never "swarm,"
  "orchestration," "agent graph," "peer," or "agent-to-agent." The vocabulary is load-bearing: it
  stops swarm assumptions (peer authority, message-passing, parallel writers) from leaking into the
  design by default.

**One-sentence model:** *A delegated context is a bounded sub-invocation of the same single durable
agent loop (ADR-0016), running in a fresh isolated context window, whose authority the **warden
mints as a strict subset of its parent's** and whose only output to the parent is a structured,
provenance-tagged artifact.* It is not a peer, not a graph node, not a second authority. The model
may **request** a narrower worker; it can never grant authority — the warden does, and only ever
*downward*.

This preserves keel's core promise exactly: **autonomy at the reasoning layer** (the model decides
*to* delegate and *what* to ask for), **determinism at the control layer** (the warden decides what
authority the child actually gets, and enforces it on every child action). Delegation does not relax
that line; it adds a new *determinism lever* (attenuated grants) to it.

---

## 1. Required design invariants (the rubric this design must satisfy)

These are the maintainer's stated invariants, restated as the acceptance rubric. Every later section
maps back to these numbers.

1. **One enforcement point.** All child actions traverse the same warden (`warden.execute`).
2. **Model can only request delegation.** It cannot mint or widen authority.
3. **Monotonic attenuation.** A child's authority is a **subset** of its parent's, never an
   expansion — for tools, filesystem scope, egress, *and* resource budget.
4. **Warden is sole audit writer.** Unchanged from ADR-0017; concurrency never adds a second writer.
5. **Delegation is attributable.** Agent principal + parent link + grant id/hash + causal lineage.
6. **Structured artifact return, not raw context.** Child output re-enters the parent as a
   provenance-tagged artifact (summary + evidence refs), never as merged raw context/reasoning.
7. **Unknown/mixed provenance fails closed to untrusted.** Reuses the §4.7.8 / SEC-023 invariant.
8. **No persistent child memory** in the first shipped slices.
9. **No parallel *write* authority, ever.** Read-only parallel fan-out **is** a first-class early
   capability (Slice 1b): it is safe because reads do not conflict, the warden is the single
   serializer of the audit chain (so ordering holds under concurrency), and per-session attribution
   exists from Slice 1. Claim-grade attribution (`AgentPrincipal` + provable lineage) still lands in
   Slice 2 — the *capability* ships early, the *claim* does not. The sequential single-child skeleton
   (Slice 1a) ships first only as the walking skeleton, not as a permanent constraint.
10. **No new security claim** unless the audit/policy/warden path **structurally** proves it.

---

## 2. Architecture

### 2.1 The shape (where each responsibility lives)

```
        ┌─────────────────────────────── KERNEL (untrusted) ──────────────────────────────┐
        │  parent runAgentLoop  (session ses_A, context window A)                          │
        │     model emits tool call: delegate{ purpose, instructions, requestedScope }     │
        │            │                                                                      │
        │            ▼  (kernel tool dispatch intercepts `delegate`)                        │
        │   1. ask warden to MINT a child grant (Slice 2)  ─────────────┐                   │
        │   4. run child runAgentLoop (session ses_B, fresh window B)   │                   │
        │      every child tool call → warden.execute{sessionId:ses_B,  │                   │
        │                                              grantId, ...}     │                   │
        │   6. receive DelegatedContextResult, hand to parent as a      │                   │
        │      provenance-tagged tool_result                            │                   │
        └───────────────────────────────────────────────────────────────┼──────────────────┘
                                                                          │ JSON-RPC (App. A)
        ┌──────────────────────────────── WARDEN (trusted) ──────────────▼──────────────────┐
        │  2. validate requestedScope ⊆ parent grant; MINT child grant (signed, attenuated)  │
        │  3. record delegation.grant in the audit chain (sole writer)                       │
        │  5. on each warden.execute{ses_B, grantId}: enforce action ⊆ grant ∩ policy ∩ sbx  │
        │     (defense in depth: grant check is structural, not just a Rego rule)            │
        └────────────────────────────────────────────────────────────────────────────────────┘
```

Key properties of this shape:

- **The warden never runs a model.** It mints/authorizes the spawn and governs each child action; the
  *loop* always runs in the kernel. This keeps the warden small and model-free (it has no provider
  keys, no context) — preserving §4.2's trust boundary.
- **`delegate` is a kernel-orchestrated meta-tool, not a warden RPC the warden executes.** The model
  requests it like any tool; the kernel's tool dispatch handles it by (Slice 2) minting a grant and
  running a child loop. The warden's role on spawn is *authorization* (mint), not *execution*.
- **Every child action is an ordinary `warden.execute`** keyed by the child's own `sessionId` (and,
  Slice 2, `grantId`). So children inherit the full trust plane (sandbox + policy + audit + egress)
  automatically — invariant 1 holds by construction, not by new enforcement code.
- **The child returns a structured artifact through the existing `ToolResult` channel** — invariant 6
  reuses the tool-result + taint machinery rather than inventing context handoff.

### 2.2 Why this is not "multi-agent" (the line ADR-0016 keeps)

| Rejected (still "never") | Why it's excluded | What we do instead |
|---|---|---|
| Workflow DAGs / orchestration graphs | Each edge is a new audit surface (ADR-0016) | A single durable loop; a child is a bounded sub-invocation, not a node |
| Peer agents / handoffs / swarm / A2A | Distributes authority → confused-deputy, agent-in-the-middle | Single-parent tree; authority only attenuates downward; no inter-child messaging |
| Tool routers / intent classifiers | §1.4 non-goal; the per-action warden gate supersedes them | The model decomposes; the warden gates per action |
| Parallel **writers** | Conflicting edits + audit-ordering loss | Parallel **read-only** fan-out is allowed early (Slice 1b); parallel *writes* are never |
| Sub-agents with own credentials/log | Multiple authority sources; violates invariants 1 & 4 | One warden, one chain; children hold a grant *reference*, never credentials |

The delegation structure is a **tree** (every child has exactly one parent; no node has two parents
because there is no peer-merge). It is overlaid on the single linear audit chain via parent-links. We
call the audit projection a "delegation tree," not a DAG, to avoid implying diamonds/merges that the
design forbids.

---

## 3. The grant model (the crux — invariants 2, 3, 5)

### 3.1 `DelegationGrant` (new `@keel/shared` schema; not frozen until Slice 2 integration)

A grant is the warden's authoritative, signed statement of *exactly what a child may do*. The kernel
and model never hold authority — they hold an opaque `grantId` and may only request a *narrower* one.

| Field | Type | Meaning / attenuation rule |
|---|---|---|
| `grantId` | `gnt_<ULID>` | Stable id; appears in audit + every child `execute`. |
| `version` | int | Grant schema version (independent of RPC protocol version). |
| `parentGrantId` | `gnt_<ULID>` \| `null` | `null` only for the **root** grant (derived from the session's resolved authority). Forms the tree. |
| `agentPrincipal` | `AgentPrincipal` | The child's identity (see §3.2). |
| `depth` | int | Root = 0; child = parent.depth + 1. Hard-capped (§6). |
| `humanPrincipal` | `Principal` | The accountable human (unchanged shape); carried through unchanged — delegation never changes *who* is ultimately responsible. |
| `effectEnvelope` | subset of ADR-0024 taxonomy | Allowed `effectKinds` × `scopes` × `targetKinds` × max `sensitivity`. **MUST ⊆ parent.effectEnvelope.** Read-only worker: `effectKinds ⊆ {fs_read, network_read?}`. |
| `toolAllow` | `string[]` | Allowlisted tool names. **MUST ⊆ parent.toolAllow.** Deny-by-default (empty ⇒ nothing). |
| `workspaceScope` | path globs | Filesystem roots the child may touch. **MUST ⊆ parent.workspaceScope.** Read-only ⇒ no write roots. |
| `egressScope` | domain set | Domains reachable. **MUST ⊆ parent.egressScope.** Exploration default: ∅. |
| `budget` | `{tokens, wallClockMs, maxToolCalls, maxDepth, maxFanout}` | Each **carved from the parent's remaining budget** (resources attenuate too — a fork bomb cannot mint budget). |
| `caveats` | predicate list | Additional **narrowing-only** constraints, evaluated by the existing Rego engine over `PolicyInput` (e.g. "paths under `src/` only"). Caveats can only *remove* authority. |
| `provenanceFloor` | `ProvenanceTag` | The child's inputs start at ≥ the parent's current taint; the child can never be *less* tainted than its parent context. |
| `notBefore` / `expiresAt` | timestamps | Short TTL; valid only for the child's run. Expired grant ⇒ all child actions denied. |
| `parentBindingHash` | `Sha256` | SHA-256 of the parent grant's canonical JSON. The child grant's signature covers this, so lineage cannot be forged, reordered, or re-parented (the confused-deputy fix). |
| `issuer` | `"warden"` | Only the warden mints. |
| `sig` | `Ed25519Sig` (2B) / chain-pinned (2A) | Signed by the warden key (Phase 2B). In 2A the grant is hash-chained/tamper-evident but unsigned — same honesty split as ADR-0027. |
| `grantHash` | `Sha256` | SHA-256 over canonical JSON (sans `sig`), pinned in the audit record. |

**The attenuation invariant (the whole security idea), enforced two ways:**

1. **At mint:** the warden computes `childAuthority = requestedScope ∩ parentAuthority` and **refuses
   to mint** if the request asks for anything outside the parent (it does not silently clamp by
   default — it denies and returns guidance, so the model learns; a *clamp* variant may be offered
   for ergonomics but the default is deny-on-expansion to keep the model's mental model honest).
   Because the warden holds the parent grant and **recomputes from it**, the model (acting through an
   uncompromised kernel) cannot widen authority by inflating `requestedScope` — the warden ignores
   any kernel-asserted authority and intersects with the parent it holds.
2. **At every `execute`:** the warden re-checks `action ⊆ grant` *structurally*, independent of the
   policy pack. Even a buggy/missing Rego rule cannot let a child exceed its grant (defense in depth,
   mirroring ADR-0056's "sandbox is authoritative" posture).

**Threat-boundary honesty (do not overclaim).** This defeats the *model/prompt-injection* escalation
path (the v1 threat): a fooled model requesting more authority is intersected down to the parent.
It does **not**, on its own, defend against a **compromised kernel that lies about *which* parent a
child descends from** (passing a higher-privileged `parentGrantId` it legitimately knows). A fully
compromised kernel is **explicitly outside the v1 threat model (§3.3)**. Closing that gap requires
the warden to own the session→active-grant binding (so a mint under parent `X` is only honored on a
session actually executing under `X`) — which is the **same reserved hardening** ADR-0033 already
names for warden-owned `session` consent state, "for strict deployments that must withstand a
compromised kernel." Treat warden-owned grant-lineage binding as a Slice-2+ hardening option gated by
an ADR, **not** a v1 claim. The parent-binding hash (§3.1 `parentBindingHash`) defeats *forgery/
reordering/re-parenting of a recorded lineage*; it does not by itself defend a live compromised kernel
choosing a legitimate-but-higher parent.

This is the object-capability model: identity proves the caller; the grant proves the (narrowed)
authority; attenuation is monotonic; lineage is verifiable.

### 3.2 `AgentPrincipal` (new schema) — invariant 5

Distinct from the human `Principal` (which answers "which human is accountable"); the
`AgentPrincipal` answers "which delegated context acted."

```
AgentPrincipal {
  agentId:        "agt_<ULID>"        // unique per delegated context
  parentAgentId:  "agt_<ULID>" | null // null for the root
  role:           string              // "explore" | "review" | "test-run" | … (descriptive, not authority)
  grantId:        "gnt_<ULID>"        // the grant under which it acts
  humanPrincipal: Principal           // unchanged; the accountable human flows through
}
```

`role` is descriptive only — authority comes from the grant, never the role name (no "inference from
names," per the charter). The root context's `AgentPrincipal` is synthesized so that *all* actions —
even the top-level loop's — are uniformly attributable once Slice 2 lands.

### 3.3 Grant primitive choice (a real sub-decision — **stop-and-ask + spike before Slice 2**)

| Option | License | Pros | Cons for keel |
|---|---|---|---|
| **Biscuit** | Apache-2.0 | Purpose-built offline attenuation; public-key verifiable; Datalog caveats | Adds a **second authorization language** (Datalog) alongside Rego — violates §4.2 "one policy language everywhere"; new WASM/binary artifact (bun-compile cost, à la ADR-0004); solves a cross-service trust problem keel doesn't have |
| **Macaroons** | permissive | Simple caveat-chaining; single warden = issuer+verifier, so symmetric HMAC suffices | JS libs poorly maintained; third-party offline verification weak (we want the *audit chain* to be the verifiable artifact anyway) |
| **UCAN** | permissive | DID-keyed delegation chains | Built for **decentralized** cross-service delegation; DID machinery is dead weight for a single local warden |
| **Bespoke-minimal (recommended)** | n/a (own code) | Reuses keel's existing **@noble + JCS** crypto (ADR-0006), **Rego** engine (ADR-0004) for caveats, **ADR-0024** taxonomy + **ADR-0056** manifest for the envelope vocabulary; **zero new deps**; no new WASM; attenuation is pure enumerated-set subset logic | We hand-roll the attenuation check (must be carefully property-tested + adversarially reviewed); not a "standard" |

**Recommendation: bespoke-minimal.** keel already owns every primitive a grant needs — canonical
hashing + signing (the audit chain), a policy engine (for caveats), and a frozen effect taxonomy +
capability manifest (for the envelope). The cross-service standards solve *decentralized trust across
mutually-distrusting services* — a problem keel explicitly does not have (single local warden, no
A2A, no peer agents, §1.4). Adopting Datalog would put a second authorization language next to Rego,
which §4.2 forbids on purpose.

**But be adversarial about it:** "bespoke" + "authority token" is exactly where hand-rolled subtlety
bites. Three hard guards make this safe rather than reckless, and they are non-negotiable:
- **Reuse crypto verbatim — invent none.** Signing/canonicalization is the *same* @noble + RFC 8785
  JCS path the audit chain uses (ADR-0006). No new crypto primitives.
- **Attenuation is set algebra over enumerated fields only** — `child ⊆ parent` across
  `effectEnvelope`, `toolAllow`, `workspaceScope`, `egressScope`, `budget`. No free-form logic. This
  is a **property** (`∀ child: authorityLeq(child, parent)`) and gets fast-check tests proving no
  mint and no `execute` can ever produce `child ⊄ parent`.
- **Decide via a timeboxed spike, ADR-0004-style.** Before the Slice 2 freeze, run a 2-day spike
  comparing bespoke-minimal vs biscuit on (a) attenuation-correctness test coverage, (b)
  bun-`--compile` binary impact, (c) reviewer confidence. **If the subset logic proves subtle or the
  review is uneasy, adopt biscuit despite the second-language cost** and record that in the ADR. The
  recommendation is bespoke; the *gate* is the spike.

### 3.4 Lifecycle

`mint → (child runs, every action re-checked ⊆ grant) → return artifact → expire/revoke`. Grants are
short-lived (TTL = child run + small slack). The parent (or a human) can **revoke** a grant, which
cancels the child subtree (§6 cancellation). Revocation and expiry are audited. No grant outlives its
session.

---

## 4. Context merge — the safe handoff (invariants 6 & 7)

The hardest unsolved problem from the options memo (ADR-0025 names "multi-agent context handoff" an
explicit non-goal). The design **sidesteps it by not doing context handoff at all** — only a
structured artifact return through the existing taint boundary.

### 4.1 `DelegatedContextResult` (new schema; returned as a `ToolResult`)

```
DelegatedContextResult {
  grantId, agentId,
  summary:        string             // bounded findings — what the worker concluded
  evidenceRefs:   ArtifactRef[]      // ledger/artifact refs (ADR-0025 ArtifactRef) — the receipts
  fileRefs:       { path, readAtHash }[]   // what it inspected (for read-before-edit, §4.7.10)
  provenanceTag:  ProvenanceTag      // MAX taint of every input the child consumed (≥ provenanceFloor)
  uncertainty:    string | null      // explicit "what I could not determine" (no false confidence, §4.7.9)
  budgetSpent:    { tokens, wallClockMs, toolCalls }
  stopReason:     StopReason         // reuses the existing enum incl. "deadline"/"budget"
  ok:             boolean            // false ⇒ structured-error channel (no throw, no auto-retry)
}
```

### 4.2 The merge rules (reuse, don't reinvent)

- **The parent receives the artifact as a normal `tool_result`** (the `delegate` tool's return value).
  It flows through the existing `ToolResultEvent` ledger path and `ExecutorPort.ToolResult` channel.
  **No raw child message history, no hidden reasoning, ever enters the parent context** — only
  `summary` + `evidenceRefs`. This is what makes "context doesn't compose" (Cognition's critique) a
  non-issue: we never compose contexts; we return a bounded artifact.
- **Max-taint propagation.** `provenanceTag = max(all child input tags, anything the child ingested)`,
  never below `provenanceFloor`. Unknown ⇒ `untrusted` via the existing `provenanceTagFromTrustLevel`
  boundary mapper. So if a read-only worker read an untrusted file, its summary is untrusted-derived,
  and if the parent later tries to egress it, **POL-011 (untrusted-derived → review at egress) fires
  unchanged.** No laundering. This is exactly the SEC-023 invariant applied at a new boundary; the
  merge adds *no* new taint rule, it reuses the compaction-laundering one.
- **Evidence refs are pointers, not payloads.** The parent gets refs into the ledger/artifacts (which
  retain their own provenance), not copies — so trust state is never silently upgraded by copying.

**Adversarial check on this:** is summary-only *useful enough*? For the justified use cases —
read-only exploration ("find where auth expiry is handled and summarize"), codebase Q&A, review — the
summary + file/evidence refs **is** the useful output (it matches how read-only Explore subagents
work in practice). For write-heavy or tightly-coupled work it is deliberately *not* enough — and that
work is out of scope (invariant 9; §7 "never"). If a future slice needs richer handoff, that is a new
design with a new SEC test for laundering, not an incremental loosening.

---

## 5. Audit & attribution (invariants 4 & 5)

### 5.1 Slice 1 — open-payload marker, **no frozen-format change**

Reuse two existing, proven patterns:
- **Child session lineage** rides the existing, non-frozen `SessionMetaEvent.parent {id, atIndex}`
  (already used by `keel sessions branch`). Each delegated context = its own `ses_<ULID>` with a
  parent link. Because every `AuditRecord` already carries `sessionId`, **child actions are
  attributable by session for free.**
- **Delegation metadata** rides the **open `payload` `JsonObject`** as a `delegation` marker
  `{ grantId?, parentSessionId, agentRole, depth, requestedScope }` on existing event types — exactly
  the precedent set by ADR-0033 (`sessionGrant`) and ADR-0056 (`findings[] policy_sandbox_mismatch`).
  **This is un-validated and not load-bearing → Slice 1 makes no attribution security claim.**

### 5.2 Slice 2 — first-class fields (**frozen audit-format change → stop-and-ask + ADR**)

Promote to validated, load-bearing fields on the audit record so the claim becomes possible:
- Add `agentPrincipal` and `grant: { grantId, parentGrantId, grantHash }` to the audit record.
- Add event types `delegation.grant` / `delegation.revoke` to `AuditEventType` (additive ⇒ MINOR per
  ADR-0012, but still a frozen-format change ⇒ ADR + audit schema version).
- The **delegation tree is then reconstructable and verifiable from the chain**: every action maps to
  an `agentPrincipal`; every grant's `parentBindingHash` chains to its parent; an offline check
  proves *no child ever exceeded its parent's authority*. This is the differentiator — and it
  *restores* ADR-0016's "the record survives the agent" across delegation (the rationale that single-
  agent originally protected). **Tamper-evident at 2A (hash chain), offline-verifiable at 2B
  (signing)** — same honesty split as ADR-0027; do not claim offline-verifiable lineage before 2B.

---

## 6. Budget, resource & failure controls (invariants 3 & 9; CORBA defense)

All hard-capped; warden-enforced in Slice 2, kernel-enforced (honest, non-claimed) in Slice 1.

- **Depth cap.** Slice 1: **depth 1** — only the root may spawn; children **cannot** spawn at all
  (kills the fork-bomb class outright for the first slice). Later slices may raise to a small fixed,
  non-configurable cap (Claude Code uses 5; keel should start far lower and justify any increase).
- **Fan-out cap.** Max children per parent (small, fixed).
- **Token budget.** Child budget is *carved from the parent's remaining* tokens (sum of children ≤
  parent remaining) — resource attenuation, so delegation cannot manufacture compute.
- **Wall-clock deadline.** Child deadline ≤ parent remaining; reuses ADR-0051 graceful-finalize +
  `StopReason: "deadline"`.
- **Max tool calls** per child.
- **Cancellation.** Reuses the existing `ExecutorPort.execute(opts.signal)` AbortSignal; cancelling a
  parent cancels its entire subtree; grant revocation cancels the child.
- **Failure propagation.** A child failure returns `ok:false` with a structured-error artifact —
  **never a throw, never an auto-retry** (§4.3). The parent model decides recovery, keeping the audit
  narrative faithful.
- **Execution model.** The walking skeleton (Slice 1a) runs a single child at a time to prove the
  seam simply. **Parallel read-only fan-out then ships as Slice 1b:** the parent spawns N read-only
  children, they run concurrently, and the parent gathers all their artifacts. This is safe because
  (i) reads do not conflict, (ii) the **warden is the single serializer** of the audit chain — N
  concurrent `warden.execute` calls queue through one append path, so `seq`/`prevHash` stay a valid
  total order (the RPC client already multiplexes concurrent in-flight calls), and (iii) each action
  is attributable by its child `sessionId`. **Parallel *writes* remain never** (invariant 9): the
  conflict/ordering hazard is the write axis, which stays banned. Concurrency is still bounded by the
  fan-out + budget caps above, and a parent's cancellation/failure cancels its whole live subtree.

This directly answers the resource-exhaustion / contagious-recursion (CORBA) threat and extends
SEC-017 (fork-bomb) to the delegation layer.

---

## 7. Slices (the delivery plan)

| Slice | What ships | Frozen changes? | Security claim? |
|---|---|---|---|
| **1a — Sequential skeleton** | Read-only, **single-child** depth-1 delegated context (walking skeleton); per-child `sessionId`; restricted child tool surface (read/search only); hard caps; artifact return with max-taint; open-payload audit marker; receipt/status surfacing | **None** (if it lands ≥ Phase 2A so child actions are warden-governed) | **No.** DX / context-isolation only. |
| **1b — Parallel read fan-out** | Concurrent **read-only** children: parent spawns N, they run in parallel, parent gathers all artifacts; bounded by fan-out + budget caps; chain ordered by the single warden serializer; attribution by `sessionId` | **None** | **No.** DX / breadth-first-exploration; read-only still convenience-not-enforced. |
| **2 — Structural authority attenuation** | Warden-minted attenuated grants; `AgentPrincipal`; structural `child ⊆ parent` enforcement at mint + execute; first-class delegation audit fields; PolicyInput agent dimension; grant-primitive spike→ADR | **Yes:** App. A (methods + optional `grantId`), App. B (fields + event types), App. D §D.1 (agent dim). Each stop-and-ask + protocol/audit version bump. | **Possible** (only once denied-path tests pass — see §Deliverable 6). |
| **3 — OS hardening** | Per-child **OS sandbox profile** via `SandboxPort` (a child's profile = its grant projected to the sandbox), once Epic 2.2 is real | Reuses ADR-0005/0056 seams; no *new* frozen contract | Strengthens existing claims (blast radius). |

*(There is no "parallel write" slice — parallel writes are permanently out, invariant 9. Deeper
recursion (depth > 1) and any richer-than-artifact handoff are separate future designs, each with
their own gate and SEC test; they are not in this plan.)*

**Recommended phase placement (maintainer decision):**
- **Slices 1a/1b should not land before Phase 2A.** Shipping a "subagent" while the warden is off
  would create exactly the "looks like a security feature but isn't" confusion the charter forbids.
  Landing them ≥ 2A means child actions are *already* sandbox+policy+audit-governed (via the child
  `sessionId`); only the *attenuation/grant* is deferred to Slice 2. That is an honest story:
  "isolated parallel contexts now; provably-bounded authority next." 1a (sequential skeleton) and 1b
  (parallel read fan-out) are best delivered as one epic — 1a is the walking skeleton, 1b builds out
  concurrency on top of it.
- **Slice 2 aligns with Phase 4 item 6** ("subagent context isolation") — it touches interfaces that
  only freeze at 2A and is most credible once 2A enforcement (and ideally 2B signing) exists.

---

## 8. UX, status line & receipt (invariant: honest-by-construction; Autopilot ≠ YOLO)

- **A delegated context is shown as a subordinate, indented activity** under its parent — never as a
  peer running "on its own." e.g. `⤷ explore (read-only): locate auth-expiry handling …`. The
  language is "delegated," never "autonomous agent."
- **Posture is fail-toward-parent and never weaker than the parent.** The status line shows the child
  inheriting the parent's mode/sandbox/egress posture, *minus* whatever the grant removed. It must
  **never** render a child as having more authority than the parent or as relaxing enforcement.
  Delegation is an *attenuation*, so the only honest movement is *down*.
- **Receipt (§4.9.4) gains a delegation section**, drawn from the ledger (Slice 1) / audit chain
  (Slice 2) — never model self-report:
  ```
  Delegated contexts:
  - explore (read-only) → 9 reads, 0 writes, 0 egress · summary returned (workspace-tainted)
  - review  (read-only) → 12 reads, 0 writes · 2 findings (untrusted-derived → egress would review)
  ```
- **Autopilot ≠ YOLO holds exactly.** A delegated context is another *requester* with *less*
  authority; it is never an enforcement bypass and never implies a guarantee not structurally
  enforced. Slice 1's status surface must additionally say, honestly, that read-only-ness is a
  tool-surface convenience, not an enforced bound, until Slice 2.

---

## 9. Eval gate (justify by isolation/exploration/quality — never "swarm intelligence")

The ADR-0016 re-evaluation trigger is a *benchmark gap that cannot be closed by harness
improvements*. So delegated contexts must be **measured**, not assumed. Justify only by:

- **Context-window relief:** large-codebase / long tasks that overflow the parent window complete
  with delegated read exploration vs. fail/degrade without. (Primary justification.)
- **Exploration recall:** delegated read workers locate the relevant files/context at **≥ parity**
  with inline search on a fixture set.
- **Breadth-first fan-out win (Slice 1b):** on tasks with N independent exploration threads (e.g.
  "survey these 5 subsystems"), parallel read fan-out reaches the same recall as sequential
  exploration at materially lower **wall-clock** — measured on a fixture set, with the ~N× token
  cost reported honestly alongside the latency win. (This is the *legitimate* parallelism claim:
  faster breadth-first **reads**, never a write-throughput or "swarm intelligence" claim.)
- **Review quality:** a read-only "review" context surfaces seeded issues at ≥ parity.
- **No benchmark regression:** TB-2.1 score must not drop (same "trust plane must not make the agent
  dumber" gate as §2.1; budget the token cost honestly — the efficacy evidence says coding
  *write*-parallelism is weak, so we are explicitly **not** claiming a speed/accuracy win on writes).
- **Honesty kill-switch:** if the Slice 1a/1b eval shows little isolation/recall/latency value,
  **stop — do not build Slice 2.** The slicing is itself the over-engineering guard.

Slice 2 adds the **security/adversarial evals** (denied-path) listed in Deliverable 6.

---

# Deliverable 2 — ADR amendment / authoring plan

| ADR | Action | Why | Gate |
|---|---|---|---|
| **ADR-0016** (single-agent loop) | **Narrow amendment** (precedent: ADR-0028 already amends it for retries) | Permit *bounded delegated contexts* while **re-affirming** the "never" list (DAGs, peer agents, A2A, swarm/network, tool routers, parallel writers). State that the single durable loop remains the unit; a delegated context is a bounded, attenuated sub-invocation, not a graph/peer. Re-affirm the benchmark re-eval gate. | Stop-and-ask (security-claim-bearing stance). Before Slice 2 design freeze. |
| **NEW ADR — Delegated authority grants** | Author | The grant model (§3): fields, attenuation invariant, mint-only-by-warden, parent-binding, lifecycle, **primitive choice (records the §3.3 spike outcome)**. The core of Option B. | Pairs with the App. A/B/D version bump. Stop-and-ask. |
| **NEW ADR — Delegation attribution & audit representation** (or a section of the grant ADR) | Author | Slice 1 open-payload marker → Slice 2 first-class fields + `delegation.grant`/`delegation.revoke` event types; audit schema version bump; governed by ADR-0012 + ADR-0027. | Stop-and-ask (frozen audit format). Slice 2. |
| **ADR-0017** (authority model) | **Amend** | Add to the "MAY NOT" list: *the model may not mint, widen, or re-parent a grant; it may only request a narrower delegated context.* Introduce `AgentPrincipal` as the per-agent identity complement to `Principal`. | Stop-and-ask. Slice 2. |
| **ADR-0012** (protocol versioning) | Reference (no change) | Confirms additive method + optional field = MINOR; the bump procedure. | — |
| **ADR-0056** (capability manifest) | Reference (no change) | The grant `effectEnvelope` is expressed in the manifest's taxonomy vocabulary; a child sandbox profile (Slice 3) is the grant projected through the same manifest→sandbox generator. | — |

---

# Deliverable 3 — Frozen-contract impact table

| Contract | Frozen? | Slice 1 impact | Slice 2 impact |
|---|---|---|---|
| **Appendix A — Warden RPC** | FROZEN (ADR-0012) | **None** — spawn is kernel-orchestrated; child actions use existing `warden.execute` with the child `sessionId`. | **MINOR bump:** new `warden.delegate.mint` (+ `warden.delegate.revoke`); optional `grantId` added to `ExecuteParams`. New protocol version + ADR. |
| **Appendix B — Audit record** | FROZEN at 2A (ADR-0027) | **None** — `delegation` rides open `payload` (ADR-0033/0056 precedent); child lineage rides `SessionMetaEvent.parent`. | **Format change:** first-class `agentPrincipal` + `grant{…}`; new `delegation.grant`/`delegation.revoke` event types. Audit schema version + ADR. |
| **Appendix D §D.1 — PolicyInput** | FROZEN at 2A (ADR-0027) | **None.** | **Format change:** additive optional `agent { agentId, grantId, parentGrantId, depth, effectEnvelope, caveats }` so Rego can reason over delegated scope. ADR. |
| **`@keel/shared` — `DelegationGrant`** | New (not frozen until Slice 2) | n/a | New schema; frozen at Slice 2 integration (à la ExecutorPort/ADR-0021). |
| **`@keel/shared` — `AgentPrincipal`** | New | n/a | New schema. |
| **`@keel/shared` — `DelegatedContextResult`** | New (not frozen) | New schema (returned as a `ToolResult`); evolvable. | — |
| **Session schema (`session/events.ts`)** | NOT frozen | Reuse `SessionMetaEvent.parent`; optional additive `delegation` envelope event. | Additive as needed. |
| **`ExecutorPort`** | NOT frozen until warden integration | **None** — `delegate` is a tool, not a port method; child loop reuses `runAgentLoop` + the same executor with a child `sessionId`. | Possibly an optional `grantId` threaded to `execute` (still pre-freeze for child path). |
| **`AuditEventType` enum** | Frozen at 2A | None (payload marker) | `+delegation.grant`, `+delegation.revoke` (MINOR + ADR). |
| **Crypto / canonicalization (ADR-0006)** | — | None | Reused verbatim for grant signing/hashing — **no new crypto**. |

**Net:** Slice 1 touches **nothing frozen**. Every frozen change is isolated to Slice 2 and is
additive (MINOR-class), each paired with its ADR + version bump + stop-and-ask.

---

# Deliverable 4 — First implementation epic plan (Slice 1 = 1a + 1b)

> Draft, to be promoted verbatim into a public tracking issue or linked pull request when
> scheduled (epic number = maintainer's call; see §7 phase placement).
> Scope is **Slice 1a (sequential skeleton) + Slice 1b (parallel read fan-out)** — one epic, because
> 1b builds concurrency directly on 1a's seam. Slice 2 (grants/claims) is a *separate later* epic.

## Epic D1 — Delegated contexts: read-only skeleton + parallel fan-out (Slice 1) — Implementation Plan

### Spec references
- `MASTER_SPEC.md`: §1.1, §1.4, §4.2, §4.3, §4.7.8/.9/.10, §4.9 (status/receipt), §7 Phase 4 item 6.
- ADRs: ADR-0016 (+ pending amendment), ADR-0025 (artifact/taint), ADR-0033 (open-payload marker
  precedent), ADR-0051 (wall-clock), ADR-0008 (session branch lineage).
- Design: this document.

### Scope
A read-only, **depth-1** delegated-context capability: a new kernel `delegate` tool that runs a child
`runAgentLoop` in a fresh context window and its own `ses_<ULID>` (parent-linked), with a restricted
tool surface (read/search only), hard caps (depth=1, fan-out, tokens, wall-clock, tool-calls),
structured `DelegatedContextResult` return carrying **max-taint** provenance, an open-payload
`delegation` audit marker, and honest status-line + receipt surfacing. **1a** delivers the single-
child walking skeleton; **1b** delivers **concurrent read-only fan-out** (parent spawns N, gathers
all artifacts), bounded by fan-out + budget caps and serialized into the chain by the one warden.
Lands ≥ Phase 2A so child actions are warden-governed via their `sessionId`.

### Local non-goals (explicit)
- No grant minting, no `AgentPrincipal`, no warden `delegate.*` RPC (that is Slice 2).
- No frozen-schema change (App. A/B/D untouched).
- No child writes, no child egress, no child memory proposals, no nested spawning (depth-1).
- **No parallel *writes*** (reads may run concurrently; writes never do). No security claim of any kind.
- No richer context handoff than summary + evidence/file refs.

### Interfaces / packages touched
- packages: `@keel/kernel` (new `delegate` tool, child-loop orchestration incl. concurrent scheduling
  + result aggregation, status/receipt), maybe `@keel/shared` (new non-frozen `DelegatedContextResult`,
  `delegation` payload marker type).
- schemas: `DelegatedContextResult` (new, not frozen); optional session `delegation` envelope event.
- CLI/contracts: none frozen; help text for the tool; receipt section.
- docs: this design; linked public work item; claim ledger.

### Tests first (TDD)
- **Property:** child authority/tool-surface ⊆ parent (read/search only); a child cannot invoke a
  write/egress tool (kernel-side restriction) — *labeled non-security* but tested.
- **Property:** `provenanceTag` of the result = max taint of child inputs; unknown ⇒ untrusted
  (extends SEC-023 to the merge boundary) — including the **merge of N concurrent** children.
- **Property/unit:** caps enforced — depth-1 (child cannot spawn), fan-out, token, wall-clock
  (`deadline` stop), max-tool-calls; cancellation of parent cancels **all live** children (AbortSignal).
- **Concurrency (1b):** N parallel read children all return; the audit chain stays a valid single
  total order (`seq`/`prevHash` linkage holds) under concurrent `warden.execute` — property test over
  interleavings; aggregated budget across live children never exceeds the parent's remaining.
- **Concurrency partial failure (1b):** one child fails/times out while others succeed → parent gets
  the successes + a structured `ok:false` for the failure; no throw; no auto-retry.
- **Integration (simulator):** parent delegates a read-only exploration; child returns artifact;
  parent consumes it as a `tool_result`; **no raw child history enters the parent context** (assert).
- **Integration:** child actions appear in the audit/session stream attributed to the child
  `sessionId` with the `delegation` marker + `parent` lineage.
- **Reliability:** kill -9 mid-fan-out leaves a resumable/consistent ledger; no orphaned child sessions.
- **DX golden:** status line shows children as subordinate concurrent activities (not peers); receipt
  delegation section is rendered from the ledger; honesty note present (read-only = convenience, not
  enforced).

### Walking skeleton (1a)
Parent (simulator script) calls `delegate{purpose, instructions}` → kernel spawns one child
`runAgentLoop` (read/search tools, own `sessionId`) → child does one `read` via `warden.execute` →
returns `DelegatedContextResult{summary, fileRefs, provenanceTag}` → parent receives it as a
`tool_result`. Proves the seam end-to-end across kernel + (if present) warden.

### Implementation slices
1. Walking skeleton (1a, above). 2. Caps + cancellation + failure channel. 3. Max-taint merge +
read-before-edit ref handling. 4. Audit marker + session lineage. 5. **Parallel read fan-out (1b):
concurrent child scheduling, result aggregation, partial-failure handling, fan-out/budget accounting
across live children, single-serializer ordering test.** 6. Status line + receipt (incl. concurrent
display). 7. Docs + linked public work item or roadmap update.

### Risk register
| Risk | Impact | Mitigation |
|---|---|---|
| "Subagent" read as a security feature | Honesty breach | Status/docs label Slice 1 as DX, no claim, read-only = convenience-not-enforced |
| Parallel children multiply token cost (~N×) | Cost | Budget carved from parent + fan-out cap; eval gate reports latency-vs-token tradeoff before Slice 2 |
| Concurrent writes to one session / chain corruption | Integrity | One session per child; warden is the sole serializer; ordering property test over interleavings; ADR-0008 (one writer per session) preserved |
| Raw child context leaks to parent | Taint laundering | Artifact-only return; integration test asserts no raw history merge (incl. N-child merge) |
| Orphaned/leaked child sessions on failure | Reliability | Cancellation propagates to whole live subtree; kill -9 test; clean close-on-return lifecycle |
| Scope creep toward writes/nesting | Architecture drift | Hard non-goals; depth-1; parallel **reads only** |

### Definition of done
- tests: all above green (incl. the concurrency + partial-failure + ordering tests); coverage ≥ kernel
  floor (≥85%).
- commands: `pnpm test` / `typecheck` / `lint` / `format` — actual results recorded (no hidden green).
- docs: design linked; public roadmap or linked work item updated.
- gates: no frozen-contract change (assert via the App. A/B/D contract suites still green unchanged);
  no new security claim added to the ledger.

### Stop-and-ask triggers
Any frozen interface touched; any read-only-ness presented as *enforced*; any nested spawning, child
write/egress, **parallel writes**, or a new dependency.

### Residual risks / follow-ups
Slice 2 (grants/attribution/claim) and its ADRs; grant-primitive spike; per-child sandbox (Slice 3).
Deeper recursion (depth > 1) and any richer-than-artifact handoff are separate future designs, each
with its own gate + SEC test. Each named with its trigger.

---

# Deliverable 5 — Non-goals & the "never" list

**Slice-1 non-goals:** grants, `AgentPrincipal`, warden `delegate.*` RPC, any frozen-schema change,
child writes/egress/memory, nested spawning, **parallel writes**, security claims, rich context
handoff. (Parallel read-only fan-out **is** in scope — Slice 1b.)

**Permanent "never" (re-affirmed from §1.4 / ADR-0016; true in every slice):**
- Workflow-DAG / graph orchestration ("full orchestration never").
- Peer agents, handoffs, swarm/network topologies, agent-to-agent (A2A) protocols.
- Tool routers / separate intent-risk classifier stage.
- Sub-agents with their own credentials, their own MCP connections the warden doesn't mediate, or
  their own audit log.
- Parallel **write** authority / shared mutable state across contexts.
- Authority that expands across a delegation boundary (grants only attenuate).
- A child setting/raising its own (or its parent's) autonomy mode or minting its own grant.

---

# Deliverable 6 — Security-claim-ledger impact

**Unchanged (Slice 1 affects none of these):** the three launch claims — (1) injection-driven
exfiltration resistance, (2) the agent cannot write its own audit record, (3) memory is
human-owned. Delegation routes through the *same* warden, *same* chain, *same* egress; it adds
surface but no new claim and weakens none.

**Slice 1 — explicitly NO claim.** Read-only-ness is a kernel-side tool-surface convenience, **not**
an enforced bound (a compromised kernel could hand a child a write tool; the warden, lacking a grant,
would judge it by ordinary per-session policy). This must be stated plainly wherever Slice 1 appears.

**Slice 2 — claims become *possible* (each added only once its denied-path test passes):**
- **SEC-DLG-1 (attenuation):** a delegated context's authority is structurally a subset of its
  parent's; the warden refuses to mint or honor an expanding grant. *Denied-path:* a (fooled) model
  requesting expansion under its legitimate parent → refused; the warden intersects with the
  parent grant it holds and ignores kernel-asserted authority. **Scope honesty:** this is the
  model/injection threat (v1). It does **not** claim to defend a *compromised kernel that lies about
  its parent lineage* — that is the §3.3 out-of-scope boundary, and the warden-owned session→grant
  binding that would close it is a reserved Slice-2+ hardening (ADR-0033 precedent), **not** a v1
  claim. Do not state SEC-DLG-1 as "withstands a compromised kernel."
- **SEC-DLG-2 (attributable lineage):** every delegated action is attributable to an `AgentPrincipal`
  with a verifiable parent-binding chain in the audit record. *Denied-path:* tampered/re-parented
  lineage is detected by chain verification. (Tamper-evident at 2A; **offline-verifiable only at
  2B** — do not claim offline before signing.)
- **SEC-DLG-3 (no laundering):** a delegated context cannot launder untrusted content into the
  parent's trusted context; the returned artifact carries max-taint. *Extends SEC-023.*
- **SEC-DLG-4 (no exhaustion):** delegation depth/fan-out/budget are hard-capped; recursive spawning
  cannot exhaust resources. *Extends SEC-017.*

**Must NOT be claimed (yet / ever):** any Slice-1 enforcement of read-only; any "secure swarm /
multi-agent" framing; offline-verifiable delegation lineage before Phase 2B; any speed/accuracy/
"swarm intelligence" win (the design is justified by isolation/exploration, not write-parallelism).

---

# Deliverable 7 — Adversarial self-assessment (required: is Option B over-engineered or unsound?)

Honest answers, because the maintainer asked for them:

1. **Is the grant machinery over-engineered?** *For Slice 1, yes — so Slice 1 doesn't build it.* The
   grant/attenuation/attribution apparatus is real engineering and is only justified if (a) Slice 1's
   eval shows delegated contexts deliver genuine isolation/exploration value **and** (b) we want a
   security claim about them. The slicing **is** the over-engineering guard: if the eval is flat, stop
   at Slice 1 (or revert it) and never pay for Slice 2.

2. **Is the bespoke grant unsound?** It *could* be, if hand-rolled carelessly. The design constrains
   it to safe ground (reuse @noble+JCS; pure enumerated-set subset checks; property-tested invariant;
   adversarial review; a spike that will switch to biscuit if the subset logic proves subtle). The
   honest residual risk: subset semantics over the ADR-0024 taxonomy have corners (scopes,
   sensitivity ordering, composition edges) — the property tests and spike exist precisely to find
   them before any claim is made.

3. **Should Slice 1 stay a non-security DX feature?** **Yes, unambiguously.** It must be labeled DX
   everywhere; read-only is convenience, not enforcement, until Slice 2. Presenting it otherwise would
   be exactly the security theater the charter forbids.

4. **Does this deliver the value the maintainer wants — including speed?** Now, largely yes. The plan
   was revised to pull **parallel read-only fan-out forward to Slice 1b**, so the breadth-first
   wall-clock win (the popular multi-agent appeal) arrives early, not in a distant gated slice — and
   it is safe to do so because reads don't conflict and the warden serializes the chain. The one
   honest caveat that remains: the win is **read/exploration latency**, not write throughput
   (parallel writes stay banned, and the evidence says write-parallelism backfires on coupled coding
   anyway). So delegated contexts deliver context isolation **and** breadth-first speed for reads,
   plus review quality — but not faster *writing*. That is the right line, and it matches the
   efficacy evidence for a coding harness.

5. **Is the core promise intact?** Yes. Autonomy at the reasoning layer (model requests delegation +
   decomposition); determinism at the control layer (warden mints + enforces attenuated authority).
   Delegated contexts give the model *more* reasoning flexibility while giving the warden a *new*
   determinism lever — they strengthen the kernel/warden split rather than eroding it.

6. **Precision check:** the audit projection is a **tree** (single parent), not a DAG — the design
   forbids peer-merges, so there are no diamonds. We say "delegation tree" to avoid over-claiming.

**Verdict:** Option B is sound *as a sliced commitment*. Slice 1 is a low-risk, no-frozen-change,
no-claim DX feature that is worth building **iff the eval shows isolation value**. Slice 2 is the
genuine differentiator but is real frozen-interface work and must clear its spike, its ADRs, and its
denied-path tests before any claim. If the Slice 1 eval is flat, the correct outcome is to stop — and
that is a feature of this plan, not a failure of it.
