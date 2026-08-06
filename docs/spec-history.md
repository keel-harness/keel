# MASTER_SPEC version history

Every revision of [`MASTER_SPEC.md`](../MASTER_SPEC.md), newest first. Each entry records what
changed in the spec and why, so a reader can tell whether a decision is current or superseded.

This is a changelog, not a specification. Nothing here is normative — the spec itself is. It lives
in its own file so that the spec opens on its first section rather than on its own history.

---

*v1.23: **Informed approval presentation sources reconciled (ADR-0081).** Live approval now has an
explicit source contract: the model contributes only the bounded requested tool name; the Warden
contributes the effective-target summary and strictly parsed exact reusable resource; fixed
controller semantics contribute reason, consequence, lifecycle, and next step. Missing facts remain
unavailable and model prose never fills a Warden gap. Choices remain once, validated exact-resource
session, deny, and explain; project authority remains external. This additive process-local
presentation decision changes no protocol 1.1 field, `UIPort` method, audit/session/eval format,
grant, verdict, settlement, enforcement, security claim, dependency, or public CLI contract.*

*v1.22: **Current runtime truth vocabulary and TUI copy ownership reconciled (ADR-0080).** Current
surfaces distinguish controller-reported `starting`, `governed`, `deliberately unenforced`,
`unavailable — tools halted`, and `status not reported` states without inferring a release phase from
posture booleans. Individual sandbox/egress/policy/audit facts remain literal; trust-mode words
require a governed controller posture. Cross-surface TUI truth copy lives in a reviewed
`tui/strings.ts` catalog, while one-off copy remains beside covered pure planners instead of moving
into a package-wide junk drawer. This additive presentation decision changes no RPC, audit/session/
eval format, warden verdict, enforcement, security claim, dependency, or public CLI contract.*

*v1.21: **Receipt recovery wording reconciled to available mutation evidence (ADR-0079).** The
current v1 producer does not retain an owned full preimage, prove a clean Git baseline, or exclude
concurrent mutation, so a generated `git restore`/removal command could erase user work. Receipts now
separate `File evidence` from operation-effect claims and provide fixed, qualified manual recovery
guidance while stating that automatic undo is unavailable. A successful command remains `Ran`; only
controller-owned validation evidence may be `Verified`, and absent validation is explicit. No
producer bytes, frozen RPC/audit/session/`UIPort` method, security claim, enforcement, or public CLI
flag changes. Automatic recovery requires a separately ADR-gated owned-preimage/checkpoint design.*

*v1.20: **Governed MCP pulled forward as a Phase-2.5 design/implementation track, scoped to local
stdio tools before Phase 3.** MCP is no longer only a Phase-4 footnote: the near-term path is
ADR-0067 + Epic 2.25 design ratification + Epic 2.26 governed local-stdio MCP, using the existing
warden projection seam and preserving the one-enforcement-model rule. The first runtime slice remains
tools-only, post-trust, explicit-review, pinned, sandboxed, audited, and conservative/opaque by
default; resources, prompts, sampling, elicitation, remote Streamable HTTP, localhost HTTP, remote
roots, curated allowlists, and Autopilot quieting are follow-ons. Remote MCP remains hard-gated on
Phase-3 provenance enforcement because arguments to a remote server are egress payloads. No runtime
code, frozen Appendix A/B/D/E schema, public CLI contract, telemetry, provider-egress, extension API,
or MCP security claim changes are made by this spec update; plugin/MCP remains outside the current
Phase-2 product claim until executable SEC-MCP evidence exists.*

*v1.19: **Phase-2 closeout wording reconciled to shipped evidence and accepted limitations.** This
update records the final Phase-2 closeout posture after Epic 2.19, the 2026-06-30 compiled-binary
Ed25519 regression fix, and the build-gated eval-direct executor commit. Phase 2 is now treated as
**implementation/readiness complete with named limitations** for a constrained private developer
preview, not as an unqualified all-green gate pass and not as Phase-3 entry. The claimed product
tool surface is scoped to governed `bash` plus trusted `read`/`search`/`write`/`edit`; helper/internal
surfaces, provider API calls, plugins/MCP, and future tools remain outside the claim. P2A accepted
limitations remain explicit: no macOS audit-latency pass and no comparable live TB-2/TB-2.1 benchmark proof.
P2B limitations remain explicit: bundle authenticity requires out-of-band signer-key comparison;
checkpoint-boundary truncation needs an external expected head/count anchor or future signed
manifest; redacted-bundle verification is pre-write redaction only; same-user at-rest key theft is out
of scope. No Appendix A/B/D/E, public CLI contract, frozen schema, telemetry, external-service,
public-alpha, compliance, or Phase-3 memory/provenance claim changes.*

*v1.18: **Phase-2 closeout sequencing made explicit (Epic 2.14 through 2.19).** Phase 2
now closes through a conservative gate sequence before Phase 3 starts: Epic 2.14 audits the
remaining P2A/P2B gaps and locks the work order; Epic 2.15 converges typed-tool execution
through the warden; Epic 2.16 closes the security-suite/doc-limit/demo gaps; Epic 2.17 runs
the P2A exit-gate measurement and harness-quality stabilization; Epic 2.18 ships Phase-2B
evidence hardening; Epic 2.19 performs the final closeout, developer-preview readiness
review, and claim-ledger reconciliation. ADR-0027's architectural split is unchanged, but
the current build chooses not to use its earlier allowance for Phase 2B to run in parallel
with Phase 3 unless the owner explicitly revises this sequencing. No code, frozen interface,
policy/audit schema, CLI contract, or security claim changes in this spec-only sequencing update.*

*v1.17: **Governed model routing local product path shipped (Epic 2.13).** `@keel/shared` now owns
strict non-frozen model-routing schemas plus a non-frozen `model_route` session-ledger metadata event.
The kernel has a local `ModelGateway` above frozen `ModelPort`; the gateway defaults to locked/current
provider, computes harness-derived route metadata without raw prompt text, applies local policy filters
before routing preference, supports deterministic static modes (`locked`, `auto-cost`, `auto-balanced`,
`auto-quality`), fails closed on missing credentials, denied data boundaries/classes/capabilities,
unknown price under cost/budgeted routing, budget overflow, and fallback crossing policy/data boundaries,
and exposes a decision-only preview with zero upstream call. Product `keel run` wraps the configured
`provider/model` port with the gateway, records route decisions into session metadata, and surfaces route
mode plus `/model`, `/model why`, and `/model preview` in the TUI. ADR-0065 is accepted. No Appendix
A/B/D/E, `WARDEN_METHODS`, `AuditRecord`, `PolicyInput`, `SideEffect`, grant-scope, frozen `ModelPort`,
provider-egress enforcement, all-tool governance, signed/offline evidence, compliance, provenance-taint
enforcement, telemetry, or speculative/hedged dispatch claim landed.*

*v1.16: **`/goal` and `/loop` run-control product path shipped (Epic 2.12).** `@keel/shared` now owns
first-class, non-frozen `Goal` and `LoopConfig` schemas plus non-frozen session-ledger metadata events
for goal lifecycle, goal completion audits, loop iterations, and loop stops. The kernel has a ledger-based
completion audit: command criteria are satisfied only by matching non-read-only bash execution evidence,
narrative criteria require resolvable ledger citations, model self-report does not count, failed/read-only
evidence stays incomplete, and criteria that pass without configured validation report `unverified` rather
than green/complete. Product constructors are now wired through `keel run -p ... --goal ... --goal-check
...`, `keel run -p ... --loop-until ...`, and idle slash commands `/goal ... --check ...` and `/loop ...
--until ...`; `/loop` runs bounded in-session iterations through the existing runner and injected
`ExecutorPort`, with executor-owned bash exit checks and ledger `loop_iteration`/`loop_stopped` evidence.
Lifecycle-action loop checks and loop effect envelopes fail closed until warden profile narrowing can
enforce them. No Appendix A/B/D/E, `WARDEN_METHODS`, `AuditRecord`, `PolicyInput`, `SideEffect`,
grant-scope, scheduler/background loop, all-tool governance, real-model product-path, signed/offline
evidence, compliance, or provenance-taint claim changes landed.*

*v1.15: **Lifecycle manifest + validation posture governed-bash slice shipped (Epic 2.11).** A trusted
`.keel/lifecycle.yaml` is now parsed through `ProjectReader`, validated by a strict shared schema, hashed
over canonical parsed JSON, forwarded to the spawned warden as secret-free parent-side config, and
advertised as `lifecycle.run` only for trusted valid manifests. The warden resolves action argv from its
own loaded manifest, ignores model-supplied command/posture authority, lowers the action to the existing
governed `bash` execution path, and records JSON-safe lifecycle intent markers in open audit payloads
while preserving normal side-effect classification, policy, sandbox, egress, review, and audit handling.
ADR-0058 is accepted. No Appendix A/B/D/E, `WARDEN_METHODS`, `AuditRecord`, `PolicyInput`, `SideEffect`,
grant-scope, status/HUD, all-tool governance, real-model product-path, validation receipt, posture-profile
selection, signed/offline evidence, compliance, or provenance-taint claim changes landed.*

*v1.14: **Governed model routing reserved as Epic 2.13 (no implementation yet).** ADR-0065 proposes a
future local `ModelGateway` above `ModelPort` so model selection can be policy-filtered, deterministic,
visible, and planned for audit integration without letting the model select its own authority. This is a
design-stage adjunct, not a P2A gate expansion and not a provider-egress enforcement claim:
`params.model` remains a provider-local override today; Appendix A/B/D and `ModelPort` are unchanged;
model-call audit events or warden-owned policy inputs require a separate ADR-gated schema change. See
ADR-0065.*

*v1.13: **Lifecycle manifest + validation posture reserved as Epic 2.11.** The
Modelcode/Morph-inspired design spike is accepted as a future Phase-2 adjunct, not as a current runtime
claim: `.keel/lifecycle.yaml` is repo-authored validation intent, never authority; lifecycle commands
lower into ordinary `warden.execute` calls and still traverse side-effect classification, policy,
sandbox, egress, and audit. Validation posture extends ADR-0033's policy-posture model rather than
creating a second policy engine; `regulated`/compliance product claims remain deferred until signed
bundles and offline-verifiable evidence exist. Anchor:
`docs/design/2026-06-24-lifecycle-validation-posture-spike.md`.*

*v1.12: **Phase-2A R1 audit/policy format freeze landed.** The `side-effect-taxonomy/v1` multi-axis shape is now threaded into the frozen-pending formats: `AuditRecord.sideEffect` is required on `tool.execute` and `tool.deny` and optional elsewhere; `PolicyInput.sideEffect` is required for every policy verdict. §4.8, Appendix B, Appendix D §D.1, §4.3, and ADR-0028 are reconciled to the dynamic-only retry predicate (`@keel/shared` `isRetryEligible`). `policy_sandbox_mismatch` is decided as an open-payload finding marker on the existing audit event that observed the disagreement, not a new `eventType`. `TrustLevel.unknown` maps fail-closed to `ProvenanceTag.untrusted` at the audit/policy boundary. ADR-0024, ADR-0056, and ADR-0013 are accepted as the R1 bundle; ADR-0006 is pinned to JCS/RFC 8785. **Still honest:** this freezes the format only; the live warden classifier/sandbox/policy enforcement and the §7 classifier acceptance gate land during Phase 2A.*

*v1.11: **Phase-2 pre-warden prerequisites landed as PROPOSALS — not a frozen-format change and not warden code.** The three load-bearing prerequisites are designed, drafted, and verified, pending two ratification gates. **(1) Side-effect taxonomy** — ADR-0024 **RE-OPENED → revised to a multi-axis model** (effect kind · scope · target[] · modifier · classifier-confidence · taxonomy-version, plus composition/dataflow edges so exfiltration is structurally distinguishable from a benign sequence); `bash` "broad" becomes static-envelope metadata; composites (exfiltration, supply-chain, credential-access, …) are policy-derived, not frozen; implemented as the `@keel/shared` `SideEffect` schema + a 34-case §7 adversarial classifier corpus; companion **ADR-0056 capability manifest** (one source of truth generating/validating policy ⇄ sandbox ⇄ egress ⇄ conformance tests). **(2) OAP / OQ-8** — **ADR-0013 DECIDED: do NOT conform**; keep keel's record a bespoke, OAP-mappable superset (OAP is a single-vendor draft whose record has no hash-chain/seq/Merkle); borrow only JCS/RFC-8785 + Ed25519. **(3) Policy engine** — **ADR-0004 spike DONE**: opa-wasm measured (built-in gap = none for keel's pack; p99 ≈ 0.09 ms ≪ 5 ms), decision **provisional pending a `bun --compile` standalone-binary smoke test (Gate R2)**; regorus documented fallback. **Still gated (Gate R1, before warden build):** ratify the bundle (human + judge); **rewrite §4.8 / Appendix B / Appendix D §D.1 to the multi-axis shape** (proposed text in `docs/design/2026-06-22-2a-audit-policy-freeze-reconciliation.md`); pin the ADR-0006 canonicalizer to JCS/RFC-8785 (the schema owns set-array ordering); thread `sideEffect` into `AuditRecord` (optional) + `PolicyInput` (required); decide the `policy_sandbox_mismatch` audit representation. Hardened by an independent **5-lens adversarial QC pass** (must-fixes resolved TDD). Decision record: `docs/design/2026-06-22-side-effect-taxonomy-decisions.md`. **No new security claim; no frozen schema/protocol changed yet** — the §4.8 / Appendix-B/D rewrite is the 2A freeze, performed at R1, not here.*

*v1.10: **§4.7 context lifecycle & compaction — production wiring SHIPPED(Epic 1.6c), env-gated `KEEL_COMPACTION` DEFAULT-OFF** (no new security claim; no frozen-schema change — the resume bound chose the in-memory path, ADR-0049). The §4.7 architecture is now realized + shipping behind a flag, NOT a future design. As-built: **(a) a content-aware deterministic compression tier** (generic dedup+head/tail · log error-line retention · search relevance-lite) that compresses aged tool-result bodies in place before any model fold, emitting an auditable `ContextCompressionEvent` (ADR-0045); **(b) a cache-aware net-gain guard** (ADR-0046) — compressing rewrites the cached request prefix, so the in-loop trigger refuses a net-NEGATIVE rewrite on effective-token/cache-cost grounds and fires INFREQUENTLY in large chunks (amortize, don't thrash); **(c) an in-loop compactor** whose PRIMARY trigger is **RUNWAY** (gross tokens approaching `KEEL_MAX_GROSS_TOKENS`), escalating deterministic-pass → model fold; **(d) a just-in-time `retrieve(ref)` tool** — the §4.7.4/§4.7.9 expand path: the elision marker cites the artifact ref and `retrieve` resolves it to the FULL output from the canonical ledger (SEC-023 — the record is never compressed, only the view); **(e) a re-compaction bound** (ER-021) so a steering re-drive / fresh-process resume does not re-expand-then-re-fold every cycle (the ADR-0035 round-trip keystone is unchanged — `rebuild` still treats compaction as audit metadata; the full history stays canonical); **(f) the OQ-10 compactor-model seam defaulting to a deterministic, model-free `facts→TaskState` summarizer** (honest by construction — every field traces to the ledger; nothing laundered past `validateTaskState`). **HONEST FRAMING (load-bearing):** compaction's value is **RUNWAY** (shrink the per-turn view → more turns before the gross cap kills the task), NOT cost — prompt caching already makes re-sent context cheap, so the cache-aware guard is a FORECAST, and **no runway/cost benefit is claimed until the pre-registered paid OFF-vs-ON ablation measures it** (the gate for any default-ON; the arm is built + unit-tested, not run). Two rounds of independent 7-lens adversarial QC (guards mutation-tested) found no must-fix. ADRs 0045/0046/0049; cross-refs §4.7, ER-021 (resolved), ER-039/Epic 1.12 (the source-side complement — observation normalization).*

*v1.9: cost/context efficiency + honesty, surfaced by a fresh-session Phase-0 audit and an independent end-of-epic QC pass (**no new security claim**). **(a) Honest cost measurement (Epic 1.14).** The earlier "~6× more expensive than the reference" reading was largely **our own eval spend-ledger lying** — it priced input at the full un-cached rate, ignoring the **measured 92–95% prompt-cache discount**; keel's real cost is ~1.2× the reference, and the real dollars are **output tokens (~40–47%)**, not cache geometry (which already works — `cache_control` reaches the wire on a stable, append-only prefix, now proven by wire-level + prefix-stability CI tests). Added `realCostUSD` (cache-discounted), measured cache-read-ratio telemetry on the §8.2 metric, and a **permanent assumed-vs-actual drift guard** (`assertCacheWeightConsistent`: the budget cap's `cacheReadWeight` must track the real price ratio, else CI fails). The money-safety **spend GUARD stays on the conservative un-cached upper bound** (unchanged). **(b) Cache-write capture (ADR-0047)** — one **additive optional** `cacheCreationInputTokens` on the frozen `ModelUsage` (the lone frozen-schema touch — ADR-gated, opened for review, **not auto-merged**) so `realCostUSD` prices writes (1.25×) exactly *when fed a write count*; figures from pre-capture records remain read-only lower bounds. **(c) Spend-guard real-cost recalibration (ADR-0048 — Option A, signed off 2026-06-18).** The eval **monthly accumulator** (`monthToDateUSD`) now sums REAL cache-discounted cost (each record gains an **additive** `realCostUSD`; legacy records fall back to the un-cached `costUSD` UB, never under-counting) so the $25/run·$300/mo caps (ADR-0022) are denominated in real dollars. **Both money-safety GUARD points stay pessimistic and unchanged** — the per-run pre-spend check rides the un-cached UB estimate and the post-spend `actual ≤ estimate` backstop rides the UB actual; the real figure is accumulator + reporting input only, never a single-run spend license. The tighter **Option-B** cache-floor *estimate* is deferred to the (not-yet-run) paid ablation. **(d) Over-generation guard (ER-037, output side)** — an **advisory / warn-only** family-keyed signal that redirects (and **never halts**) the measured churning-name large-file re-emission mode (bash heredoc + typed `write`); mechanism-only, **no benefit claimed** until the §2.3 ≥3-seed ablation measures it. Convergence efficiency (the gross-cap unconverged-death mode, ER-038) remains the open lever. ADRs 0047/0048; cross-refs §4.7, §8.2, Appendix F, ER-037/038.*

*v1.8: Phase-1-execution design refinements, surfaced by the Epic 1.11 TB-2.1 efficiency/quality probe and a deep multi-agent QC pass (no new security claim, no frozen-schema/protocol change). **(a) Cost-aware budget controller** — the per-run token budget (`KEEL_MAX_TOKENS`) became an **effective-cost** cap, not a raw-token one: cached input is discounted by a provider-supplied `cacheReadWeight` (the capability table, ADR-0030), with a gross-token emergency backstop (`KEEL_MAX_GROSS_TOKENS`) and an output-token over-generation guard (`KEEL_MAX_OUTPUT_TOKENS`). The money-safety invariant `effective ≤ gross` is enforced **structurally** (clamps on weight ∈ [0,1] and cached ≤ input, property-tested), not by trusting the caller/provider. ADR-0044; the in-loop budget enforcement is warden-independent (the model only reports usage; the loop decides). **(b) Conversation-prefix prompt caching** — the tiered cache-friendly assembly (§4.7 / Epic 1.3) now marks the *settled conversation prefix* (system head + last message), not just the static system prompt, so a long task re-reads its whole prior conversation from cache (~0.1× on Anthropic) instead of re-sending it uncached; `cachedInputTokens` is recorded per turn as the substrate for the §8.2 effective-cost-per-resolved-task metric. ADR-0030 (cache strategy) extension. **(c) Run-start workspace snapshot** — a Phase-1 **input-safety net** (§4.8): before the agent's first action on a *trusted* workspace, keel takes a bounded, fail-open, read-only backup of the originals (opt-out `KEEL_NO_SNAPSHOT`) so a destructive tool call is recoverable. It is **not a security claim** and not part of the §4.9 autonomy-mode contract — the structural successor is the Phase-2 sandbox/provenance plane; it nets the destructive side-effect class (§4.8) until then. ADR-0043. Convergence efficiency (output discipline, churn/stagnation detection) remains the next lever after the §2.3 budget-parity matrix (the unresolved ER-038 convergence/runway issue); the large-generated-artifact guard is reserved Phase-2 warden policy (ER-037).*

*v1.7: mid-run steering — added a normative **§4.10 Mid-run steering and the input queue** (table-stakes coding-agent UX). Three input classes: **queued comment** (default — applied at safe injection boundaries: after the current tool/turn, before the next edit / risky action / final answer / compaction / plan-expansion / scope boundary), **immediate interrupt** (`Esc`/`/interrupt`/`Ctrl-C`; no new actions, summarize, stay resumable), and **urgent override** (`/now`·`/before-next-edit`·`/stop-after-current`; applied before the next mutating action) — with a pending-input indicator (`… · input:1`) and a one-line ack. Mid-run input is a **session-ledger event** (Epic 1.4; reserves `input_id`/`class`/`inserted_at`/`changed_task_state`/`invalidated_plan`), persisted, **survives resume**, **preserved through compaction** as recent-verbatim/constraints (§4.7), and **honored by Autopilot before scope expansion / mutation** (narrowing eager, expanding via the §4.9.3 approval path). **No frozen-schema change** — steering rides the keel-internal session JSONL (ADR-0008); the warden-audit-chain question is a reserved §4.10.2 seam for the Phase-2A freeze. Epic pointers 1.4/1.5/1.6; §8.6 steering/queue gate. ADR-0034.*

*v1.6: usability/autonomy design — added a normative **§4.9 Autonomy modes and approval UX** (Guided / Autopilot / Project Autopilot / YOLO as **policy postures over the warden**, not model behavior; the Autopilot decision model keyed off the §4.8 side-effect taxonomy + warden verdicts + grants, never model confidence; scoped approvals + review queue; the ledger/audit-derived **Autopilot receipt**; plan-approved Autopilot + advisory permission forecast; scope budget + broad-rewrite guard + low-confidence stop as intent-alignment heuristics; quiet mode + live task ledger + work-until-blocked; teach-from-corrections into the Phase-3 memory plane). The section adds **no new security claim and no new enforcement primitive** — it is a usability layer over §3.2; modes reuse the existing `mode.change` audit event and `once`/`project` grant scopes (**no schema/protocol change**). Cross-refs in §1.3, §4.3, §4.8; two §2.1 DX metrics (receipt accuracy, status-line posture honesty); §8.5/§8.6 UX gates; epic pointers (1.5 status line/quiet/receipt · 1.6 alignment surfaces · 2.3 scoped approvals/review queue · 2.4 mode-posture/`/why-blocked` · 2.8 status-line mode state · 3.4 teach-from-corrections · 3.7 task presets). ADR-0033; OQ-13. **Autopilot is explicitly not YOLO.***

*v1.5: memory-design review — made the **file-native topic-document** thesis explicit (durable memory = readable topic docs as the source of truth; any index is an eval-gated acceleration layer, never the store — Epic 3.2/3.5, Appendix C); added the explicit memory **lifecycle** (observe → stage → review → **consolidate** → retrieve → supersede/invalidate/redact/delete) with the topic-doc + `memory-candidates/<session>.md` file layout (Epic 3.4); added **provenance/trust + evidence + topic** fields to memory entries/candidates (Appendix C, §4.7.7) so untrusted content cannot silently become trusted memory; reconciled categories (`project_fact · procedural · decision · environment_quirk · flaky_test · security_policy · preference`, preference fast-follow); reframed retrieval as **lexical-first, vectors/graph only if evals prove insufficient** (no DB/vector dependency in v1); and made the **memory evals** explicit (recall · staleness · conflict-resolution · evidence-citation · poisoning-resistance · procedural-recall · no-silent-trust-upgrade · experience-following). ADR seed 0029.*

*v1.4: folded in a Phase-1-readiness design review — added a Phase-1 **human-usability exit gate** (§2.1, §7, §8.5) so benchmark competence alone does not pass; a normative **Context Lifecycle & Compaction** architecture (§4.7) whose core principle is *compaction is state preservation under a token budget, not summarization*, with provenance-through-compaction invariants reserved from Phase 1; a **tool side-effect taxonomy** (§4.8 — static capability + dynamic resolved effect) feeding policy/audit/retry; a precise **tiered retry policy** (§4.3); a **Kernel DX contract** (§8.6); **split Phase 2 → 2A (minimum trust plane) / 2B (evidence hardening)** and moved the private developer preview to after 2A; **deferred executable extensions** behind the warden (Epic 1.8 → declarative-only in alpha); **sequenced Phase-3 memory** (procedural/project-fact + supersession first; preference/vector/auto-accept fast-follow; auto-accept OFF by default); **scoped the three launch claims** to defensible wording (§1.2); and added cross-phase attack scenarios **SEC-023..SEC-026** (§8.1). ADR seeds 0024–0028 (§10.1).*

*v1.3: incorporated harness-as-runtime research (durable execution, trajectory-quality evals, the agent-computer interface, multi-store memory) — adopting its reliability posture while reaffirming the thin-harness thesis against its orchestration surface. Added the operating principle "autonomy at the reasoning layer, determinism at the control layer" (§1.1) and ADR-0016; expanded the §1.4 non-goals with rationale; added the no-auto-retry/model-driven-recovery principle (§4.3, §6.4); added trajectory-quality scoreboard metrics and the MemoryAgentBench four-capability framing for the memory eval (§8.2, OQ-9); expanded the Epic 0.5 prior-art checklist (repo/code map, structured test results, task ledger, initializer pass); made the in-session task ledger explicit (Epic 1.6); and clarified the memory taxonomy / episodic memory (Epic 3.2). Then folded in a v1.2 design review: forward-compat seams (principal identity fields in Appendix A/B, ADR-0017 agent-authority model, evidence-bundle redaction-level, `source-ledger.md`), later-phase completeness (memory-admission rubric + rejection taxonomy in Epic 3.4, policy-explainability surfaces in Epic 2.4, a golden hostile-repo corpus across Epics 1.7/2.9), scope-downs (vector index de-gated from alpha; functional-not-beautiful replay at P2), a **private developer-preview feedback gate after Phase 2**, tightened POL-006, and reaffirmed MCP / tool-permission-manifest / request-level MITM egress as Phase 4 with explicit seam notes.*

*v1.2: incorporated agent-memory state-of-the-art research — hybrid retrieval, forgetting semantics, procedural memory, time-anchor normalization, and memory benchmarks — into Phase 3 epics, §8.2, Appendix C, and ADR seeds.*

*v1.1: incorporated benchmark-performance research (LangChain harness-engineering, KRAFTON Terminus-KIRA, Stanford Meta-Harness, Anthropic eval-noise) into §2.3, Phase 0/1 epics, §8.2, Appendix F.*
